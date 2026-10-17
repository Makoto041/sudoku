import type { SubmitResponse } from "./api";
import { api } from "./api";
import type { ClearRecord } from "./records";
import { mergeRecords, validRecords } from "./records";
import { KEYS, load, loadByPrefix, save } from "./storage";

// 記録は読むところで検証する（日付や難易度が正しくない記録は捨てる）。summarize は日付を計算するので、
// 書き換えられた保存データや受け取った履歴の不正な行がそのまま入ると例外になる

/** この端末に残っている今日の一問の結果 */
export function localRecords(): ClearRecord[] {
  return validRecords(
    loadByPrefix<SubmitResponse>("sudoku:result:").map(([, r]) => ({
      date: r.date,
      difficulty: r.difficulty,
      points: r.points ?? null,
      timeMs: r.timeMs,
    })),
  );
}

/** 前回取ったサーバーの履歴 */
function cachedRecords(): ClearRecord[] {
  return validRecords(load<unknown>(KEYS.historyCache));
}

/** 端末にある記録（前回取ったサーバーの履歴と端末の結果） */
export function deviceRecords(): ClearRecord[] {
  return mergeRecords(cachedRecords(), localRecords());
}

/** サーバーの履歴と端末の結果を合わせる。サーバーに届かなければ端末の分だけ（前回の取得分も使う） */
export async function loadRecords(playerId: string): Promise<{ records: ClearRecord[]; offline: boolean }> {
  const local = localRecords();
  try {
    const { entries } = await api.history(playerId);
    save(KEYS.historyCache, entries);
    return { records: mergeRecords(validRecords(entries), local), offline: false };
  } catch {
    return { records: deviceRecords(), offline: true };
  }
}
