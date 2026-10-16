import type { SubmitResponse } from "./api";
import { api } from "./api";
import type { ClearRecord } from "./records";
import { mergeRecords } from "./records";
import { KEYS, load, loadByPrefix, save } from "./storage";

/** この端末に残っている今日の一問の結果 */
export function localRecords(): ClearRecord[] {
  return loadByPrefix<SubmitResponse>("sudoku:result:").map(([, r]) => ({
    date: r.date,
    difficulty: r.difficulty,
    points: r.points ?? null,
    timeMs: r.timeMs,
  }));
}

/** サーバーの履歴と端末の結果を合わせる。サーバーに届かなければ端末の分だけ（前回の取得分も使う） */
export async function loadRecords(playerId: string): Promise<{ records: ClearRecord[]; offline: boolean }> {
  const local = localRecords();
  try {
    const { entries } = await api.history(playerId);
    save(KEYS.historyCache, entries);
    return { records: mergeRecords(entries, local), offline: false };
  } catch {
    return { records: mergeRecords(load<ClearRecord[]>(KEYS.historyCache) ?? [], local), offline: true };
  }
}
