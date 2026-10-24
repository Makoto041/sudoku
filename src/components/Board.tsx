"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { boxOf, colOf, findConflicts, rowOf } from "@/lib/sudoku/core";
import { cellLabel } from "@/lib/game/a11y";
import { isGiven, isShownWrong, isWrong, type GameState } from "@/lib/game/state";
import { usePressGuard } from "@/lib/client/press";
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
const NINE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** 何も選んだことが無いときに Tab で止まるマス。矢印キーで選ぶときの起点（中央）と同じにする */
const FIRST_TAB_STOP = 40;

/** イベントの起きたマスの番号。マスの外なら null */
function cellIndexOf(target: EventTarget | null): number | null {
  const cell = (target as Element | null)?.closest<HTMLElement>("[data-i]");
  return cell ? Number(cell.dataset.i) : null;
}

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

  // Tab で止まるのは 1 マスだけ（選んでいるマス、選んでいなければ最後に選んだマス）。ほかのマスへは矢印キーで動く
  const [lastSelected, setLastSelected] = useState(FIRST_TAB_STOP);
  if (sel !== null && sel !== lastSelected) setLastSelected(sel);
  const tabStop = sel ?? lastSelected;
  // 矢印キーで選んだら、盤面にフォーカスがあればフォーカスも動かす（読み上げも付いてくる）。
  // 数字パッドなど盤面の外にあるフォーカスは動かさない。戻す・進むなどで選択が動いたときは動かさない（useGame の followCell）
  const boardRef = useRef<HTMLDivElement>(null);
  const follow = fx.follow;
  useEffect(() => {
    const board = boardRef.current;
    if (!follow || !board?.contains(document.activeElement)) return;
    const cell = board.querySelector<HTMLElement>(`[data-i="${follow.cell}"]`);
    if (cell && cell !== document.activeElement) cell.focus();
  }, [follow]);

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
  const press = usePressGuard();
  /** マスを選ぶ。修飾キー付きなら選択に足す・外す */
  const pick = (i: number, e: MouseEvent) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) onToggle(i);
    else onSelect(i);
  };
  const onPointerDown = (e: PointerEvent) => {
    const i = cellIndexOf(e.target);
    if (i === null || (e.pointerType === "mouse" && e.button !== 0)) return;
    // click を待たず押した時点で選ぶ（タッチの反応を速くする）
    pick(i, e);
    press.down(i, e.pointerId);
    // 指のぶれで隣のマスに掛かっても選択が増えないよう、マス幅の半分（盤面の幅の 1/18）動くまではなぞったことにしない
    const slop = e.currentTarget.getBoundingClientRect().width / 18;
    drag.current = { id: e.pointerId, last: i, x: e.clientX, y: e.clientY, slop };
  };
  // 読み上げソフトの操作（ダブルタップなど）と Enter・Space は click だけが届くので、ここで選ぶ。
  // 押した時点で選んだ操作の click は無視する（なぞって選んだ後に、押したマスだけの選択に戻さない）
  const onClick = (e: MouseEvent) => {
    const i = cellIndexOf(e.target);
    if (press.click(i ?? -1, performance.now()) && i !== null) pick(i, e);
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

  const cellAt = (i: number) => {
    const r = rowOf(i);
    const c = colOf(i);
    const given = isGiven(game, i);
    const value = game.values[i];
    // 重複はいつも、解答と違う数字は「間違いをすぐ表示」がオンのときに赤くする
    const wrong =
      !given &&
      value !== 0 &&
      isShownWrong({ conflict: conflicts.has(i), wrong: isWrong(game, i) }, showMistakes);
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
    const multi = extra.includes(i);
    if (sel === i) classes.push("selected");
    else if (multi) classes.push("multi");
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
    const shown = {
      value: hidden ? 0 : value,
      given,
      wrong,
      notes: hidden ? 0 : game.notes[i],
      color: hidden ? 0 : (game.colors?.[i] ?? 0),
    };
    return (
      <Cell
        key={i}
        index={i}
        className={classes.join(" ")}
        label={cellLabel(i, shown)}
        selected={sel === i || multi}
        tabStop={tabStop === i}
        value={shown.value}
        notes={shown.notes}
        color={shown.color}
        noteHighlight={highlightSame ? selValue : 0}
        flashKey={flashOrder !== undefined ? fx.flash!.key : null}
        flashOrder={flashOrder ?? 0}
        popKey={pop ? fx.pop!.key : null}
        shakeKey={shake ? fx.shake!.key : null}
      />
    );
  };

  return (
    <>
      <div
        ref={boardRef}
        className={`board${hidden ? " is-hidden" : ""}${wave ? " is-solved" : ""}${game.selection ? " is-multi" : ""}`}
        role="grid"
        aria-label="ナンプレの盤面"
        aria-multiselectable="true"
        key={fx.solvedKey ?? "board"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {/* 行は見た目に影響しない（display: contents）。マスは盤面のグリッドにそのまま並ぶ */}
        {NINE.map((r) => (
          <div key={r} className="board-row" role="row">
            {NINE.map((c) => cellAt(r * 9 + c))}
          </div>
        ))}
      </div>
      {/* 置いた結果などの知らせ。盤面を作り直しても（解き終えたとき）残るよう、盤面の外に置く */}
      <div key="live" className="sr-only" role="status" aria-live="polite">
        {fx.say && <span key={fx.say.key}>{fx.say.text}</span>}
      </div>
    </>
  );
}

type CellProps = {
  index: number;
  className: string;
  /** 読み上げ名（位置・状態・中身・色） */
  label: string;
  /** 選んでいるマス（複数選択のマスも含む） */
  selected: boolean;
  /** Tab で止まるマス */
  tabStop: boolean;
  value: number;
  notes: number;
  /** 色の番号（0 は色なし） */
  color: number;
  noteHighlight: number;
  flashKey: number | null;
  flashOrder: number;
  popKey: number | null;
  shakeKey: number | null;
};

const Cell = memo(function Cell({
  index,
  className,
  label,
  selected,
  tabStop,
  value,
  notes,
  color,
  noteHighlight,
  flashKey,
  flashOrder,
  popKey,
  shakeKey,
}: CellProps) {
  const r = rowOf(index) + 1;
  const c = colOf(index) + 1;
  // 押す・Enter・Space は盤面の pointerdown と click で受ける
  return (
    <button
      type="button"
      role="gridcell"
      className={className}
      style={{ "--diag": r + c - 2 } as CSSProperties}
      aria-label={label}
      aria-selected={selected}
      tabIndex={tabStop ? 0 : -1}
      data-i={index}
    >
      {/* 色は数字・メモより下に敷くので、先に置く */}
      {color ? (
        <span className="mark" data-color={color} style={{ background: `var(--mark-${color})` }} />
      ) : null}
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
