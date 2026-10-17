"use client";

import type { CSSProperties } from "react";
import { remainingCounts } from "@/lib/sudoku/core";
import type { GameState } from "@/lib/game/state";
import { AutoNote, Bulb, Eraser, Palette, Pencil, Redo, Undo } from "./icons";

type ToolProps = {
  game: GameState;
  onUndo: () => void;
  onRedo: () => void;
  onErase: () => void;
  onToggleNotes: () => void;
  onToggleColors: () => void;
  onHint: () => void;
  onAutoNotes: () => void;
};

export function Tools({
  game,
  onUndo,
  onRedo,
  onErase,
  onToggleNotes,
  onToggleColors,
  onHint,
  onAutoNotes,
}: ToolProps) {
  // ヒントが使えないのは日次だけ。自動メモはフリープレイだけ
  // （練習の始めのメモは局面の前提なので、候補をすべて書き直したり全部消したりさせない）
  const canHint = game.mode !== "daily";
  const canAutoNotes = game.mode === "free";
  // 6 つ以上並ぶときは詰めて並べる
  const dense = canHint || canAutoNotes;
  return (
    <div
      className={`tools${dense ? " is-dense" : ""}`}
      style={
        dense ? ({ "--tools-n": 5 + Number(canHint) + Number(canAutoNotes) } as CSSProperties) : undefined
      }
    >
      <button type="button" className="tool" onClick={onUndo} disabled={game.history.length === 0}>
        <Undo />
        <span>戻す</span>
      </button>
      <button type="button" className="tool" onClick={onRedo} disabled={!game.future?.length}>
        <Redo />
        <span>進む</span>
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
      <button
        type="button"
        className={`tool${game.colorMode ? " is-on" : ""}`}
        onClick={onToggleColors}
        aria-pressed={!!game.colorMode}
      >
        <span className="tool-icon">
          <Palette />
          <span className="tool-badge">{game.colorMode ? "ON" : "OFF"}</span>
        </span>
        <span>色</span>
      </button>
      {canAutoNotes && (
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
  // 色モードでは数字の代わりに色を出し、残りの数は出さない
  const asColors = !!game.colorMode;
  const showLeft = showRemaining && !asColors;
  // 2 マス以上選んでいる間はメモとして入るので、メモの見た目にする
  const padMode = asColors ? " is-colors" : game.notesMode || game.selection ? " is-notes" : "";
  return (
    <div className={`pad${padMode}`}>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => {
        const left = Math.max(0, remaining[d]);
        const done = showLeft && left === 0;
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
            aria-label={asColors ? `色${d}` : showLeft ? `${d}（残り${left}）` : `${d}`}
          >
            {asColors ? (
              <span className="swatch" style={{ background: `var(--mark-${d})` }} />
            ) : (
              <span className="pad-digit">{d}</span>
            )}
            {/* 表示しないときも高さをそろえるため空で残す */}
            <span className="pad-left">{showLeft && left > 0 ? left : ""}</span>
          </button>
        );
      })}
    </div>
  );
}
