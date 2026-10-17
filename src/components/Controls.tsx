"use client";

import { remainingCounts } from "@/lib/sudoku/core";
import type { GameState } from "@/lib/game/state";
import { AutoNote, Bulb, Eraser, Pencil, Undo } from "./icons";

type ToolProps = {
  game: GameState;
  onUndo: () => void;
  onErase: () => void;
  onToggleNotes: () => void;
  onHint: () => void;
  onAutoNotes: () => void;
};

export function Tools({ game, onUndo, onErase, onToggleNotes, onHint, onAutoNotes }: ToolProps) {
  const canHint = game.mode === "free";
  return (
    <div className="tools">
      <button type="button" className="tool" onClick={onUndo} disabled={game.history.length === 0}>
        <Undo />
        <span>元に戻す</span>
      </button>
      <button type="button" className="tool" onClick={onErase}>
        <Eraser />
        <span>消す</span>
      </button>
      <button
        type="button"
        className={`tool${game.notesMode ? " is-on" : ""}`}
        onClick={onToggleNotes}
        aria-pressed={game.notesMode}
      >
        <span className="tool-icon">
          <Pencil />
          <span className="tool-badge">{game.notesMode ? "ON" : "OFF"}</span>
        </span>
        <span>メモ</span>
      </button>
      {canHint && (
        <button type="button" className="tool" onClick={onAutoNotes}>
          <AutoNote />
          <span>自動メモ</span>
        </button>
      )}
      {canHint && (
        <button type="button" className="tool" onClick={onHint}>
          <span className="tool-icon">
            <Bulb />
            {game.hints > 0 && <span className="tool-count">{game.hints}</span>}
          </span>
          <span>ヒント</span>
        </button>
      )}
    </div>
  );
}

type PadProps = {
  game: GameState;
  /** 残りの個数を出し、使い切った数字を薄くする */
  showRemaining: boolean;
  onDigit: (digit: number) => void;
};

export function NumberPad({ game, showRemaining, onDigit }: PadProps) {
  const remaining = remainingCounts(game.values);
  return (
    <div className={`pad${game.notesMode ? " is-notes" : ""}`}>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
        const left = Math.max(0, remaining[d]);
        const done = showRemaining && left === 0;
        return (
          <button
            key={d}
            type="button"
            className={`pad-key${done ? " is-done" : ""}`}
            onPointerDown={(e) => {
              if (e.pointerType !== "mouse" || e.button === 0) {
                e.preventDefault();
                onDigit(d);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDigit(d);
              }
            }}
            aria-label={showRemaining ? `${d}（残り${left}）` : `${d}`}
          >
            <span className="pad-digit">{d}</span>
            {/* 表示しないときも高さをそろえるため空で残す */}
            <span className="pad-left">{showRemaining && left > 0 ? left : ""}</span>
          </button>
        );
      })}
    </div>
  );
}
