import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DIFFICULTIES } from "@/lib/sudoku/core";
import { DIFFICULTY_FLOOR_MS, isBelowBestFloor } from "./ranking-floor";
import { rankValue } from "./store";

const SCRIPT = join(import.meta.dirname, "../../../scripts/ranking-audit.mjs");
const run = promisify(execFile);

/** 点検のスクリプトを、渡した環境変数だけで動かす（シェルの KV_* などは渡さない。本番には繋がない） */
async function audit(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--experimental-strip-types", SCRIPT], {
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

const idOf = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;
const hashOf = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);

describe("歴代ベストの点検：行が下限を下回るか", () => {
  it("難易度ごとの固定の下限より 1 ms でも短ければ下回る。ちょうどなら下回らない", () => {
    for (const d of DIFFICULTIES) {
      const floor = DIFFICULTY_FLOOR_MS[d];
      expect([d, isBelowBestFloor(d, floor - 1), isBelowBestFloor(d, floor)]).toEqual([d, true, false]);
      expect(isBelowBestFloor(d, 0)).toBe(true);
      expect(isBelowBestFloor(d, 60 * 60_000)).toBe(false);
    }
    // 以前の一律の下限（15 秒）を通った行も、ふつう以上では下回りうる
    expect(isBelowBestFloor("easy", 15_000)).toBe(false);
    expect(isBelowBestFloor("medium", 15_000)).toBe(true);
  });
});

describe("歴代ベストの点検のスクリプト（scripts/ranking-audit.mjs）", () => {
  it("接続先と読み取り専用のトークンが無ければ、何もせず使い方を出して終わる", async () => {
    const res = await audit({});
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("KV_REST_API_READ_ONLY_TOKEN");
    expect(res.stdout).toBe("");
    // 書き込みのできるトークンだけでは動かない
    expect((await audit({ KV_REST_API_URL: "http://127.0.0.1:9", KV_REST_API_TOKEN: "x" })).code).toBe(2);
  });

  it("読み取り専用のトークンで読むコマンドだけを送り、下回る行を playerId の SHA-256 で一覧する", async () => {
    // 表の中身。ふつう以上の難易度は、むずかしいの 1,001 行（2 ページ）のほかは空
    const easy = [
      { id: idOf(1), points: 5000, timeMs: DIFFICULTY_FLOOR_MS.easy - 1 },
      { id: idOf(2), points: 4000, timeMs: DIFFICULTY_FLOOR_MS.easy },
    ];
    const hard = Array.from({ length: 1001 }, (_, k) => ({
      id: idOf(100 + k),
      points: 10_000 - k,
      timeMs: k === 1000 ? DIFFICULTY_FLOOR_MS.hard - 1 : 60_000,
    }));
    const boards: Record<string, { id: string; points: number; timeMs: number }[]> = {
      "sdk:bests:easy": easy,
      "sdk:bests:hard": hard,
    };
    const seen: { command: string; auth: string | undefined }[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const [command, key, start, stop] = JSON.parse(raw) as [string, string, number, number];
        seen.push({ command: command.toLowerCase(), auth: req.headers.authorization });
        const rows = [...(boards[key] ?? [])].sort(
          (a, b) => rankValue(a.points, a.timeMs) - rankValue(b.points, b.timeMs),
        );
        const encode = (v: string) =>
          req.headers["upstash-encoding"] === "base64" ? Buffer.from(v).toString("base64") : v;
        let result: unknown = null;
        if (command.toLowerCase() === "zcard") result = rows.length;
        if (command.toLowerCase() === "zrange") {
          result = rows
            .slice(Number(start), Number(stop) + 1)
            .flatMap((r) => [encode(r.id), encode(String(rankValue(r.points, r.timeMs)))]);
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await audit({
        KV_REST_API_URL: `http://127.0.0.1:${port}`,
        KV_REST_API_READ_ONLY_TOKEN: "read-only-token",
        KV_REST_API_TOKEN: "write-token",
      });
      expect(res.code).toBe(0);
      expect(new Set(seen.map((s) => s.command))).toEqual(new Set(["zcard", "zrange"]));
      expect(new Set(seen.map((s) => s.auth))).toEqual(new Set(["Bearer read-only-token"]));
      // むずかしいは 1,000 行ずつ 2 回読む
      expect(seen.filter((s) => s.command === "zrange").length).toBe(3);

      const lines = res.stdout.trim().split("\n");
      expect(lines).toContain("easy: 2 行、下限 15.000 秒、下回る行 1");
      expect(lines).toContain(`  1 番目  5000 点  14.999 秒  id の SHA-256 ${hashOf(idOf(1))}`);
      expect(lines).toContain("hard: 1001 行、下限 30.000 秒、下回る行 1");
      expect(lines).toContain(`  1001 番目  9000 点  29.999 秒  id の SHA-256 ${hashOf(idOf(1100))}`);
      expect(lines).toContain("medium: 0 行、下限 20.000 秒、下回る行 0");
      expect(lines[lines.length - 1]).toBe("合計 2 行（読み取りだけ。何も書き換えていない）");
      // playerId そのものは出さない
      for (const r of [...easy, ...hard]) expect(res.stdout + res.stderr).not.toContain(r.id);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
