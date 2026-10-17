"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { boxOf, colOf, findConflicts, rowOf } from "@/lib/sudoku/core";
import { isGiven, isWrong, type GameState } from "@/lib/game/state";
import type { Fx } from "@/lib/client/useGame";

type Props = {
  game: GameState;
  fx: Fx;
  showMistakes: boolean;
  highlightSame: boolean;
  highlightPeers: boolean;
  /** 揃ったときと解き終えたときに光らせる */
  unitFx: boolean;
  /** 行き詰まったマス（入る数字が無い） */
  stuck: ReadonlySet<number>;
  /** 手筋ヒントで照らすマス */
  hint?: { focus: ReadonlySet<number>; pattern: ReadonlySet<number>; targets: ReadonlySet<number> } | null;
  onSelect: (cell: number) => void;
  /** 修飾キー付きクリック：選択にマスを足す・外す */
  onToggle: (cell: number) => void;
  /** なぞったマスを選択に足す */
  onExtend: (cell: number) => void;
};

/** ポインタを押したまま動かしている間の状態。slop は押した点からこれだけ動くまでなぞったことにしない距離 */
type Drag = { id: number; last: number; x: number; y: number; slop: number };

const NOTE_DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function Board({
  game,
  fx,
  showMistakes,
  highlightSame,
  highlightPeers,
  unitFx,
  stuck,
  hint,
  onSelect,
  onToggle,
  onExtend,
}: Props) {
  const sel = game.selected;
  const selValue = sel !== null ? game.values[sel] : 0;
  const extra = game.selection ?? [];
  const conflicts = useMemo(() => findConflicts(game.values), [game.values]);
  const hidden = game.status === "paused";
  // 解き終えたときの波。光らせない設定なら出さない
  const wave = game.status === "solved" && unitFx;

  // なぞって選ぶ。タッチでは押したマスにポインタが捕まり、隣のマスにイベントが来ないので、座標からマスを探す
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    const end = (e: globalThis.PointerEvent) => {
      if (drag.current?.id === e.pointerId) drag.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);
  const onPointerDown = (e: PointerEvent) => {
    const cell = (e.target as Element).closest<HTMLElement>("[data-i]");
    if (!cell || (e.pointerType === "mouse" && e.button !== 0)) return;
    // click を待たず押した時点で選ぶ（タッチの反応を速くする）
    const i = Number(cell.dataset.i);
    if (e.shiftKey || e.ctrlKey || e.metaKey) onToggle(i);
    else onSelect(i);
    // 指のぶれで隣のマスに掛かっても選択が増えないよう、マス幅の半分（盤面の幅の 1/18）動くまではなぞったことにしない
    const slop = e.currentTarget.getBoundingClientRect().width / 18;
    drag.current = { id: e.pointerId, last: i, x: e.clientX, y: e.clientY, slop };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    // ボタンを離したのに pointerup を受け取れなかったとき（窓の外で離したなど）
    if (e.pointerType === "mouse" && e.buttons === 0) {
      drag.current = null;
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < d.slop) return;
    // 一度超えたら、このドラッグでは以降ポインタの下のマスが変わるたびに足す
    d.slop = 0;
    const cell = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-i]");
    if (!cell || !e.currentTarget.contains(cell)) return;
    const i = Number(cell.dataset.i);
    if (i === d.last) return;
    d.last = i;
    onExtend(i);
  };
  // macOS の Ctrl+クリックで出るメニューを止める
  const onContextMenu = (e: MouseEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };

  return (
    <div
      className={`board${hidden ? " is-hidden" : ""}${wave ? " is-solved" : ""}${game.selection ? " is-multi" : ""}`}
      role="grid"
      aria-label="ナンプレの盤面"
      key={fx.solvedKey ?? "board"}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onContextMenu={onContextMenu}
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
        if (hint) {
          if (hint.targets.has(i)) classes.push("hint-target");
          else if (hint.pattern.has(i)) classes.push("hint-pattern");
          else if (hint.focus.has(i)) classes.push("hint-focus");
        }
        // 行・列・ブロックと同じ数字の強調は基準のマスだけで決める
        if (sel === i) classes.push("selected");
        else if (extra.includes(i)) classes.push("multi");
        else if (
          highlightPeers &&
          sel !== null &&
          (rowOf(sel) === r || colOf(sel) === c || boxOf(sel) === boxOf(i))
        )
          classes.push("peer");
        if (highlightSame && selValue && value === selValue && sel !== i) classes.push("same");
        const flashOrder = unitFx ? fx.flash?.cells.get(i) : undefined;
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
      data-i={index}
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
