"use client";

import { useMemo, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL } from "@/lib/sudoku/core";
import { techniqueProfile } from "@/lib/sudoku/logic";
import { techniqueRows } from "@/lib/sudoku/practice";
import { formatPoints } from "@/lib/game/score";
import { elapsedOf, formatTime, type GameState } from "@/lib/game/state";
import { firstMistakeLines } from "@/lib/game/review";
import type { FreeClear } from "@/lib/client/stats";
import { shareUrl } from "@/lib/client/sharedPuzzle";
import type { Achievement } from "@/lib/client/achievements";
import { AchievementLine } from "./AchievementLine";
import type { DailyOutcome } from "./Game";
import { Close, Refresh, Share, Trophy } from "./icons";

type Props = {
  game: GameState;
  outcome: DailyOutcome | null;
  freeClear: FreeClear | null;
  /** このクリアで新しく解除した実績 */
  fresh: Achievement[];
  /** 次の問題を作っている */
  generating: boolean;
  onRetrySubmit: () => void;
  onRanking: () => void;
  onHome: () => void;
  onNewFree: () => void;
  onClose: () => void;
};

export function Result({
  game,
  outcome,
  freeClear,
  fresh,
  generating,
  onRetrySubmit,
  onRanking,
  onHome,
  onNewFree,
  onClose,
}: Props) {
  const [shared, setShared] = useState<string | null>(null);
  const isDaily = game.mode === "daily";
  const done = outcome?.state === "done" ? outcome.result : null;
  const time = done ? done.timeMs : elapsedOf(game);
  // 日次はサーバーが計算し直した点数、まだ届いていなければ端末の点数
  const points = done?.points ?? game.score?.points ?? 0;
  const bonus = done?.timeBonus ?? game.score?.timeBonus;
  // 問題を手筋で解いたときの道筋（難易度の判定と同じ）。遊んだ人の手順ではない
  const techniques = useMemo(() => {
    const { counts, stalled } = techniqueProfile(game.puzzle);
    return { rows: techniqueRows(counts), stalled };
  }, [game.puzzle]);
  // このプレイで最初に置いた解答と違う数字。端末の保存データにだけあり、共有する文には入れない
  const mistake = useMemo(() => firstMistakeLines(game.firstMistake), [game.firstMistake]);

  const share = async () => {
    sfx.tap();
    const label = DIFFICULTY_LABEL[game.difficulty];
    const head = isDaily ? `ナンプレ 今日の一問（${label}）` : `ナンプレ（${label}）`;
    const rank = done?.rank ? ` / ${done.rank}位（${done.total}人中）` : "";
    const text = `${head} ${formatPoints(points)}点（${formatTime(time)}）${rank}`;
    // フリープレイは同じ盤面を遊べる URL。今日の一問の盤面は共有しない（フリープレイでヒントを使って解いてから本番に入れる）
    const url = isDaily ? location.origin : shareUrl(game);
    try {
      if (navigator.share) {
        await navigator.share({ text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setShared("コピーしました");
    } catch {
      /* 共有をキャンセルした */
    }
  };

  return (
    <div className="sheet-backdrop result-backdrop" role="dialog" aria-modal="true" aria-label="クリア">
      <div className="sheet result">
        <button type="button" className="icon-btn sheet-close" onClick={onClose} aria-label="閉じる">
          <Close />
        </button>
        <div className="result-kicker">
          {isDaily ? "今日の一問" : "フリープレイ"} · {DIFFICULTY_LABEL[game.difficulty]}
        </div>
        <h2 className="result-title">クリア</h2>
        <div className="result-score">
          {formatPoints(points)}
          <span className="result-unit">点</span>
        </div>

        {isDaily ? (
          <div className="result-rank">
            {outcome?.state === "submitting" && <span className="muted">記録を送信中…</span>}
            {done && done.rank !== null && (
              <>
                <Trophy size={20} />
                <span>
                  <strong>{done.rank}</strong> 位<span className="muted"> / {done.total}人</span>
                </span>
              </>
            )}
            {outcome?.state === "error" && (
              <span className="result-error">
                {outcome.message}
                {outcome.retry && (
                  <button type="button" className="link-btn" onClick={onRetrySubmit}>
                    <Refresh size={16} /> 再送信
                  </button>
                )}
              </span>
            )}
          </div>
        ) : (
          freeClear && (
            <div className="result-rank">
              {freeClear.isBest ? (
                <span className="best-chip">自己ベスト更新</span>
              ) : freeClear.bestPoints !== null ? (
                <span className="muted">自己ベスト {formatPoints(freeClear.bestPoints)}点</span>
              ) : null}
            </div>
          )
        )}

        <AchievementLine fresh={fresh} />

        <dl className="result-stats">
          <div>
            <dt>タイム</dt>
            <dd>{formatTime(time)}</dd>
          </div>
          {bonus !== undefined && (
            <div>
              <dt>タイムボーナス</dt>
              <dd>+{formatPoints(bonus)}</dd>
            </div>
          )}
          <div>
            <dt>ミス</dt>
            <dd>{game.mistakes}</dd>
          </div>
          {!isDaily && (
            <div>
              <dt>ヒント</dt>
              <dd>{game.hints}</dd>
            </div>
          )}
        </dl>

        {(techniques.rows.length > 0 || techniques.stalled) && (
          <section className="result-techniques" aria-labelledby="result-techniques-title">
            <h3 id="result-techniques-title" className="result-techniques-title">
              要る手筋
            </h3>
            {techniques.rows.length > 0 && (
              <ul className="result-techniques-list">
                {techniques.rows.map((row) => (
                  <li key={row.key}>
                    {row.name}
                    <span className="result-techniques-count">×{row.count}</span>
                  </li>
                ))}
              </ul>
            )}
            {techniques.stalled && <p className="result-techniques-note">手筋で進めない局面あり</p>}
          </section>
        )}

        {mistake && (
          <section className="result-techniques" aria-labelledby="result-mistake-title">
            <h3 id="result-mistake-title" className="result-techniques-title">
              最初の誤り
            </h3>
            <p className="result-mistake">{mistake.main}</p>
            {mistake.technique && <p className="result-techniques-note">{mistake.technique}</p>}
          </section>
        )}

        <div className="result-actions">
          {isDaily ? (
            <button type="button" className="btn primary" onClick={onRanking}>
              <Trophy size={20} /> ランキングを見る
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={onNewFree} disabled={generating}>
              {generating && <span className="spinner" aria-hidden="true" />}
              次の問題へ
            </button>
          )}
          <div className="result-row">
            <button type="button" className="btn" onClick={share}>
              <Share size={18} /> {shared ?? "結果を共有"}
            </button>
            <button type="button" className="btn" onClick={onHome}>
              ホーム
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
