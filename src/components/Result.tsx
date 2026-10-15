"use client";

import { useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL } from "@/lib/sudoku/core";
import { elapsedOf, formatTime, type GameState } from "@/lib/game/state";
import type { FreeClear } from "@/lib/client/stats";
import type { DailyOutcome } from "./Game";
import { Close, Refresh, Share, Trophy } from "./icons";

type Props = {
  game: GameState;
  outcome: DailyOutcome | null;
  freeClear: FreeClear | null;
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

  const share = async () => {
    sfx.tap();
    const label = DIFFICULTY_LABEL[game.difficulty];
    const head = isDaily ? `数独 今日の一問（${label}）` : `数独（${label}）`;
    const rank = done?.rank ? ` / ${done.rank}位（${done.total}人中）` : "";
    const text = `${head}を ${formatTime(time)} でクリア${rank}`;
    const url = location.origin;
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
        <div className="result-time">{formatTime(time)}</div>

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
              ) : freeClear.bestMs !== null ? (
                <span className="muted">自己ベスト {formatTime(freeClear.bestMs)}</span>
              ) : null}
            </div>
          )
        )}

        <dl className="result-stats">
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

        <div className="result-actions">
          {isDaily ? (
            <button type="button" className="btn primary" onClick={onRanking}>
              <Trophy size={20} /> ランキングを見る
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={onNewFree}>
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
