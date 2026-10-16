"use client";

import { memo, useMemo, type CSSProperties } from "react";
import { boxOf, colOf, findConflicts, rowOf } from "@/lib/sudoku/core";
import { isGiven, isWrong, type GameState } from "@/lib/game/state";
import type { Fx } from "@/lib/client/useGame";

type Props = {
  game: GameState;
  fx: Fx;
  showMistakes: boolean;
  highlightSame: boolean;
  /** 行き詰まったマス（入る数字が無い） */
  stuck: ReadonlySet<number>;
  onSelect: (cell: number) => void;
};

const NOTE_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function Board({ game, fx, showMistakes, highlightSame, stuck, onSelect }: Props) {
  const sel = game.selected;
  const selValue = sel !== null ? game.values[sel] : 0;
  const conflicts = useMemo(() => findConflicts(game.values), [game.values]);
  const hidden = game.status === "paused";

  return (
    <div
      className={`board${hidden ? " is-hidden" : ""}${game.status === "solved" ? " is-solved" : ""}`}
      role="grid"
      aria-label="ナンプレの盤面"
      key={fx.solvedKey ?? "board"}
    >
      {game.values.map((value, i) => {
        const r = rowOf(i);
        const c = colOf(i);
        const given = isGiven(game, i);
        // 重複はいつも、解答と違う数字は「間違いをすぐ表示」がオンのときに赤くする
        const wrong = !given && value !== 0 && (conflicts.has(i) || (showMistakes && isWrong(game, i)));
        const classes = ["cell"];
        if (c % 3 === 2 && c < 8) classes.push("edge-r");
        if (r % 3 === 2 && r < 8) classes.push("edge-b");
        if (given) classes.push("given");
        else if (value) classes.push("filled");
        if (wrong) classes.push("wrong");
        if (stuck.has(i)) classes.push("stuck");
        if (sel === i) classes.push("selected");
        else if (sel !== null && (rowOf(sel) === r || colOf(sel) === c || boxOf(sel) === boxOf(i)))
          classes.push("peer");
        if (highlightSame && selValue && value === selValue && sel !== i) classes.push("same");
        const flashOrder = fx.flash?.cells.get(i);
        const pop = fx.pop?.cell === i;
        const shake = fx.shake?.cell === i;
        return (
          <Cell
            key={i}
            index={i}
            className={classes.join(" ")}
            value={hidden ? 0 : value}
            notes={hidden ? 0 : game.notes[i]}
            noteHighlight={highlightSame ? selValue : 0}
            flashKey={flashOrder !== undefined ? fx.flash!.key : null}
            flashOrder={flashOrder ?? 0}
            popKey={pop ? fx.pop!.key : null}
            shakeKey={shake ? fx.shake!.key : null}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

type CellProps = {
  index: number;
  className: string;
  value: number;
  notes: number;
  noteHighlight: number;
  flashKey: number | null;
  flashOrder: number;
  popKey: number | null;
  shakeKey: number | null;
  onSelect: (cell: number) => void;
};

const Cell = memo(function Cell({
  index,
  className,
  value,
  notes,
  noteHighlight,
  flashKey,
  flashOrder,
  popKey,
  shakeKey,
  onSelect,
}: CellProps) {
  const r = rowOf(index) + 1;
  const c = colOf(index) + 1;
  return (
    <button
      type="button"
      role="gridcell"
      className={className}
      style={{ "--diag": r + c - 2 } as CSSProperties}
      aria-label={`${r}行${c}列 ${value ? value : "空き"}`}
      onPointerDown={(e) => {
        // タッチの反応を click より速くする
        if (e.pointerType !== "mouse" || e.button === 0) onSelect(index);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(index);
      }}
    >
      {flashKey !== null && (
        <span
          key={`f${flashKey}`}
          className="cell-flash"
          style={{ animationDelay: `${flashOrder * 32}ms` }}
        />
      )}
      {value ? (
        <span
          key={`v${popKey ?? 0}-${shakeKey ?? 0}`}
          className={`digit${popKey !== null ? " pop" : ""}${shakeKey !== null ? " shake" : ""}`}
        >
          {value}
        </span>
      ) : notes ? (
        <span className="notes">
          {NOTE_DIGITS.map((d) => (
            <span key={d} className={notes & (1 << d) ? (d === noteHighlight ? "on hl" : "on") : ""}>
              {notes & (1 << d) ? d : ""}
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
});
