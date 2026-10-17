"use client";

import { sfx } from "@/lib/audio";
import type { Action, GameState } from "@/lib/game/state";
import { notesAfterHint, type Hint } from "@/lib/sudoku/hint";
import { Close } from "./icons";

/** 開いたときの段。間違いと「手筋では進めない」は手筋の名前が無いので、説明から見せる */
export const firstStage = (hint: Hint): 1 | 2 => (hint.kind === "wrong" || hint.kind === "guess" ? 2 : 1);

/** 盤面で照らすマス。1 段目は注目する範囲だけ、2 段目で根拠のマスと置ける・消せるマスも */
export function hintHighlight(hint: { data: Hint; stage: 1 | 2 } | null) {
  if (!hint) return null;
  const h = hint.data;
  return {
    focus: new Set(h.focus),
    pattern: new Set("pattern" in h && hint.stage === 2 ? h.pattern : []),
    targets: new Set(hint.stage === 2 ? h.targets : []),
  };
}

/** ヒントを盤面に反映する：置く・メモに反映・1マス埋める・違う数字を消す */
export function applyHint(h: Hint, game: GameState, dispatch: (action: Action) => void) {
  if (h.kind === "place" || h.kind === "guess") dispatch({ type: "hint", cell: h.cell });
  else if (h.kind === "eliminate")
    dispatch({ type: "setNotes", notes: notesAfterHint(game.values, game.notes, h.eliminations) });
  else {
    dispatch({ type: "select", cell: h.cell });
    // 色モードでも色ではなく数字を消す
    dispatch({ type: "erase", colors: false });
  }
}

type Props = {
  hint: Hint;
  /** 1 段目は手筋の名前、2 段目で説明と、盤面に反映するボタンを出す */
  stage: 1 | 2;
  /** 「もっと見る」で 2 段目に進む */
  onMore: () => void;
  /** 2 段目のボタン（置く・メモに反映・消す・1マス埋める） */
  onApply: () => void;
  onClose: () => void;
};

/** 手筋ヒントのパネル。手筋の名前 → 説明の順に見せ、盤面に反映する */
export function HintPanel({ hint, stage, onMore, onApply, onClose }: Props) {
  return (
    <div className="hint-panel" role="status">
      <div className="hint-text">
        <span className="hint-title">{hint.title}</span>
        {stage === 2 && <span className="hint-body">{hint.text}</span>}
      </div>
      <div className="hint-actions">
        {stage === 1 ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              sfx.tap();
              onMore();
            }}
          >
            もっと見る
          </button>
        ) : (
          <button type="button" className="btn small primary" onClick={onApply}>
            {hint.kind === "eliminate"
              ? "メモに反映"
              : hint.kind === "wrong"
                ? "消す"
                : hint.kind === "guess"
                  ? "1マス埋める"
                  : "置く"}
          </button>
        )}
        <button
          type="button"
          className="icon-btn small"
          aria-label="ヒントを閉じる"
          onClick={() => {
            sfx.tap();
            onClose();
          }}
        >
          <Close size={18} />
        </button>
      </div>
    </div>
  );
}
