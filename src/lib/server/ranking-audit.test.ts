import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DIFFICULTIES } from "@/lib/sudoku/core";
import { DIFFICULTY_FLOOR_MS, isBelowBestFloor } from "./ranking-floor";
import { bestsKey, rankValue } from "./rank-value";

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

type Row = { id: string; points: number; timeMs: number };
/** 偽の表。size は ZCARD の値、page は ZRANGE の [member, 並べ順の値][] */
type FakeBoard = { size: number; page: (start: number, stop: number) => [string, string][] };

/** 行を並べ順に並べた偽の表 */
function boardOf(rows: Row[]): FakeBoard {
  const sorted = [...rows].sort((a, b) => rankValue(a.points, a.timeMs) - rankValue(b.points, b.timeMs));
  return {
    size: sorted.length,
    page: (start, stop) =>
      sorted.slice(start, stop + 1).map((r) => [r.id, String(rankValue(r.points, r.timeMs))]),
  };
}

/** Upstash の REST API の偽物（この機械の中だけで受ける）。受けたコマンドと Authorization を記録する */
async function fakeUpstash(boards: Record<string, FakeBoard>) {
  const seen: { command: string; key: string; auth: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const [name, key, start, stop] = JSON.parse(raw) as [string, string, number, number];
      const command = String(name).toLowerCase();
      seen.push({ command, key, auth: req.headers.authorization });
      const board = boards[key] ?? boardOf([]);
      const encode = (v: string) =>
        req.headers["upstash-encoding"] === "base64" ? Buffer.from(v).toString("base64") : v;
      let result: unknown = null;
      if (command === "zcard") result = board.size;
      if (command === "zrange") result = board.page(Number(start), Number(stop)).flat().map(encode);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    seen,
    env: {
      KV_REST_API_URL: `http://127.0.0.1:${port}`,
      KV_REST_API_READ_ONLY_TOKEN: "read-only-token",
      KV_REST_API_TOKEN: "write-token",
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("歴代ベストの点検のスクリプト（scripts/ranking-audit.mjs）", () => {
  it("接続先と読み取り専用のトークンが無ければ、何もせず使い方を出して終わる", async () => {
    const res = await audit({});
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("KV_REST_API_READ_ONLY_TOKEN");
    expect(res.stdout).toBe("");
    // 書き込みのできるトークンだけでは動かない
    expect((await audit({ KV_REST_API_URL: "http://127.0.0.1:9", KV_REST_API_TOKEN: "x" })).code).toBe(2);
  });

  it("接続先が https でなければ（この機械の中を除く）、トークンを送らずに終わる", async () => {
    for (const url of ["http://example.com", "http://10.0.0.1:8080", "ftp://127.0.0.1", "example.com", ""]) {
      const res = await audit({ KV_REST_API_URL: url, KV_REST_API_READ_ONLY_TOKEN: "read-only-token" });
      expect([url, res.code, res.stdout]).toEqual([url, 2, ""]);
      // 接続先もトークンも出さない
      if (url) expect(res.stderr).not.toContain(url);
      expect(res.stderr).not.toContain("read-only-token");
    }
  });

  it("読み取り専用のトークンで読むコマンドだけを送り、下回る行を playerId の SHA-256 で一覧する", async () => {
    // 表の中身。ふつう以上の難易度は、むずかしいの 1,001 行（2 ページ）と、エキスパートの読めない行のほかは空
    const easy = [
      { id: idOf(1), points: 5000, timeMs: DIFFICULTY_FLOOR_MS.easy - 1 },
      { id: idOf(2), points: 4000, timeMs: DIFFICULTY_FLOOR_MS.easy },
    ];
    const hard = Array.from({ length: 1001 }, (_, k) => ({
      id: idOf(100 + k),
      points: 10_000 - k,
      timeMs: k === 1000 ? DIFFICULTY_FLOOR_MS.hard - 1 : 60_000,
    }));
    // 並べ順の値が有限の数でない行（Redis の inf など）は、点数とタイムに戻せないので数だけ出す
    const expert: FakeBoard = {
      size: 3,
      page: () => [
        [idOf(3), "inf"],
        [idOf(4), "nan"],
        [idOf(5), String(rankValue(100, DIFFICULTY_FLOOR_MS.expert))],
      ],
    };
    const fake = await fakeUpstash({
      [bestsKey("easy")]: boardOf(easy),
      [bestsKey("hard")]: boardOf(hard),
      [bestsKey("expert")]: expert,
    });
    try {
      const res = await audit(fake.env);
      expect(res.code).toBe(0);
      expect(new Set(fake.seen.map((s) => s.command))).toEqual(new Set(["zcard", "zrange"]));
      expect(new Set(fake.seen.map((s) => s.auth))).toEqual(new Set(["Bearer read-only-token"]));
      expect(new Set(fake.seen.map((s) => s.key))).toEqual(new Set(DIFFICULTIES.map(bestsKey)));
      // むずかしいは 1,000 行ずつ 2 回読む
      expect(fake.seen.filter((s) => s.command === "zrange").length).toBe(4);

      const lines = res.stdout.trim().split("\n");
      expect(lines).toContain("easy: 2 行、下限 15.000 秒、下回る行 1、読めない行 0");
      expect(lines).toContain(`  1 番目  5000 点  14.999 秒  id の SHA-256 ${hashOf(idOf(1))}`);
      expect(lines).toContain("hard: 1001 行、下限 30.000 秒、下回る行 1、読めない行 0");
      expect(lines).toContain(`  1001 番目  9000 点  29.999 秒  id の SHA-256 ${hashOf(idOf(1100))}`);
      expect(lines).toContain("expert: 3 行、下限 40.000 秒、下回る行 0、読めない行 2");
      expect(lines).toContain("medium: 0 行、下限 20.000 秒、下回る行 0、読めない行 0");
      expect(lines.some((l) => l.includes("打ち切った"))).toBe(false);
      expect(lines[lines.length - 1]).toBe("合計 2 行（読み取りだけ。何も書き換えていない）");
      // playerId そのものは出さない
      for (const k of [1, 2, 3, 4, 5, 100, 1100]) expect(res.stdout + res.stderr).not.toContain(idOf(k));
    } finally {
      await fake.close();
    }
  });

  it("ZCARD がとても大きくても、1 つの表は 100 ページ（10 万行）で打ち切って終わる", async () => {
    // いつ読んでも 1,000 行が返る表
    const endless: FakeBoard = {
      size: 1e12,
      page: (start) =>
        Array.from({ length: 1000 }, (_, k): [string, string] => [
          idOf(start + k),
          String(rankValue(100, 60 * 60_000)),
        ]),
    };
    const fake = await fakeUpstash({ [bestsKey("master")]: endless });
    try {
      const res = await audit(fake.env);
      expect(res.code).toBe(0);
      expect(fake.seen.filter((s) => s.command === "zrange" && s.key === bestsKey("master")).length).toBe(
        100,
      );
      const lines = res.stdout.trim().split("\n");
      expect(lines).toContain("master: 1000000000000 行、下限 45.000 秒、下回る行 0、読めない行 0");
      expect(lines).toContain("  先頭の 100000 行で打ち切った（残りは読んでいない）");
    } finally {
      await fake.close();
    }
  });
});
