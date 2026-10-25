// 歴代ベストの表（sdk:bests:<難易度>）で、今日の一問の下限（src/lib/server/ranking-floor.ts）を下回る行を一覧する（npm run audit:ranking）。
//
// 読み取りだけ。消す機能は無い（本番のデータを書き換えるかは別に判断する）。
// - 接続先は環境変数の KV_REST_API_URL と、読み取り専用のトークン KV_REST_API_READ_ONLY_TOKEN（Upstash の Read-Only Token）。
//   書き込みのできるトークン（KV_REST_API_TOKEN など）は読まない。.env も読まない（実行する人がその場で渡す）
// - 送るコマンドは ZCARD と ZRANGE（WITHSCORES）だけ
// - playerId は持ち主を示す秘密なので出さない。代わりに SHA-256 の先頭 16 文字を出す（あとで同じ行を見分けるため）
// - 行には盤面が無いので、その難易度のどの盤面でも下回る時間（難易度ごとの固定の下限より短い）だけを下回るとする
import { createHash } from "node:crypto";
import { Redis } from "@upstash/redis";
import { fromRankValue } from "../src/lib/server/rank-value.ts";
import { DIFFICULTY_FLOOR_MS, isBelowBestFloor } from "../src/lib/server/ranking-floor.ts";

const USAGE = `使い方: KV_REST_API_URL=<接続先> KV_REST_API_READ_ONLY_TOKEN=<読み取り専用のトークン> npm run audit:ranking
歴代ベストの表で、今日の一問の下限を下回る行を一覧する（読み取りだけ）`;

/** 1 回の ZRANGE で読む行の数 */
const PAGE = 1000;

/** 歴代ベストの表のキー（src/lib/server/store.ts の boardKey と同じ形） */
const bestsKey = (difficulty) => `sdk:bests:${difficulty}`;

const idHash = (playerId) => createHash("sha256").update(playerId).digest("hex").slice(0, 16);

const seconds = (ms) => `${(ms / 1000).toFixed(3)} 秒`;

async function main() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_READ_ONLY_TOKEN;
  if (!url || !token) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  // コマンドは 1 つずつ送る（まとめて送る自動のパイプラインは使わない）。利用状況の送信もしない
  const redis = new Redis({
    url,
    token,
    automaticDeserialization: false,
    enableAutoPipelining: false,
    enableTelemetry: false,
  });
  let found = 0;
  for (const difficulty of Object.keys(DIFFICULTY_FLOOR_MS)) {
    const key = bestsKey(difficulty);
    const total = await redis.zcard(key);
    const below = [];
    // 並べ順（点数の高い順、同点なら速い順）に少しずつ読む。読んでいる間に表が変わると、位置がずれることがある
    for (let start = 0; start < total; start += PAGE) {
      const flat = await redis.zrange(key, start, start + PAGE - 1, { withScores: true });
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const { points, timeMs } = fromRankValue(Number(flat[i + 1]));
        if (isBelowBestFloor(difficulty, timeMs)) {
          below.push({ position: start + i / 2 + 1, id: idHash(String(flat[i])), points, timeMs });
        }
      }
      if (flat.length < PAGE * 2) break;
    }
    found += below.length;
    console.log(
      `${difficulty}: ${total} 行、下限 ${seconds(DIFFICULTY_FLOOR_MS[difficulty])}、下回る行 ${below.length}`,
    );
    for (const r of below) {
      console.log(`  ${r.position} 番目  ${r.points} 点  ${seconds(r.timeMs)}  id の SHA-256 ${r.id}`);
    }
  }
  console.log(`合計 ${found} 行（読み取りだけ。何も書き換えていない）`);
}

main().catch((err) => {
  // 接続先やトークンを出さないよう、エラーの名前だけ出す
  console.error(`失敗しました (${err instanceof Error ? err.name : typeof err})`);
  process.exitCode = 1;
});
