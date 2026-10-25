"use client";

import { useCallback, useEffect, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL, parseGrid, serializeGrid } from "@/lib/sudoku/core";
import type { Action } from "@/lib/game/state";
import {
  ENTRY_ISSUE_TEXT,
  checkEntry,
  entryAction,
  givensOf,
  newEntry,
  quickIssue,
  type EntryCheck,
} from "@/lib/client/entry";
import type { Settings } from "@/lib/client/settings";
import type { SharedPuzzle } from "@/lib/client/sharedPuzzle";
import { useGame } from "@/lib/client/useGame";
import { useGameKeys, type KeyCommand } from "@/lib/client/useGameKeys";
import { Board } from "./Board";
import { NumberPad } from "./Controls";
import { ChevronLeft, Eraser, Gear, Redo, Undo } from "./icons";

/**
 * 入力が止まってから、解が 1 つかを確かめ始めるまでの時間（ms）。確かめる間は画面が止まる
 * （置く回数の上限で、手元の Mac で最悪 140ms ほど）ので、数字を入れるたびには確かめない
 */
const CHECK_DELAY_MS = 300;

const NO_CELLS: ReadonlySet<number> = new Set();
const noop = () => {};
/** 入力で使うキーだけを受け付ける（メモ・色・ヒント・一時停止のキーは何もしない） */
const accepts = (run: KeyCommand["run"]) => run !== "hint" && entryAction(run) !== null;

type Props = {
  settings: Settings;
  onBack: () => void;
  onOpenSettings: () => void;
  /** 確かめ終えた盤面で「始める」を押した（確かめるシートを出す） */
  onStart: (puzzle: SharedPuzzle) => void;
};

/**
 * 盤面を入力する画面。紙やほかのアプリの問題を入れて、フリープレイとして始める。
 * 入れた盤面は保存しない（画面を離れると消える）
 */
export function Entry({ settings, onBack, onOpenSettings, onStart }: Props) {
  const [initial] = useState(newEntry);
  // 解答が無いので、間違いとして示すのは重複だけ（設定によらない）。メモは使わない
  const { game, fx, dispatch } = useGame(initial, { showMistakes: true, autoClearNotes: false });
  const act = useCallback(
    (action: Action) => {
      const a = entryAction(action);
      return a !== null && dispatch(a);
    },
    [dispatch],
  );
  useGameKeys({ dispatch: act, game, onHint: noop, accepts });

  // 修飾キー付きのクリックも 1 マスだけ選ぶ。なぞっても選択を足さない
  const onSelect = useCallback(
    (cell: number) => {
      dispatch({ type: "select", cell });
      sfx.select();
    },
    [dispatch],
  );

  // ヒントの数と重複は入れるたびに、解が 1 つかは入力が止まってから確かめる。
  // 確かめた盤面（key）が今の盤面と違う間は、確かめている途中として始めさせない
  const key = serializeGrid(game.values);
  const quick = quickIssue(game.values);
  const [checked, setChecked] = useState<{ key: string; result: EntryCheck } | null>(null);
  useEffect(() => {
    if (quick) return;
    const t = setTimeout(() => setChecked({ key, result: checkEntry(parseGrid(key)) }), CHECK_DELAY_MS);
    return () => clearTimeout(t);
  }, [key, quick]);
  const result: EntryCheck | null = quick
    ? { ok: false, issue: quick }
    : checked?.key === key
      ? checked.result
      : null;

  return (
    <div className="screen game entry">
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="ホームに戻る">
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <span className="bar-kicker">フリープレイ</span>
          <h1 className="bar-main">盤面を入力</h1>
        </div>
        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="設定">
          <Gear />
        </button>
      </header>

      <div className="status-row entry-status">
        <span className="stat">
          <span className="stat-label">ヒント</span>
          <span className="stat-value">{givensOf(game.values)}/81</span>
        </span>
        {/* 始められない理由が変わったとき・始められるようになったときに読み上げる */}
        <span className={`entry-check${result && !result.ok ? " is-issue" : ""}`} role="status">
          {result === null
            ? ""
            : result.ok
              ? `難易度 ${DIFFICULTY_LABEL[result.puzzle.difficulty]}`
              : ENTRY_ISSUE_TEXT[result.issue]}
        </span>
      </div>

      <div className="game-body">
        <div className="board-wrap">
          <Board
            game={game}
            fx={fx}
            showMistakes
            highlightSame={settings.highlightSame}
            highlightPeers={settings.highlightPeers}
            unitFx={false}
            stuck={NO_CELLS}
            onSelect={onSelect}
            onToggle={onSelect}
            onExtend={noop}
          />
        </div>

        <div className="controls">
          <div className="tools">
            <button
              type="button"
              className="tool"
              onClick={() => act({ type: "undo" })}
              disabled={game.history.length === 0}
            >
              <Undo />
              <span>戻す</span>
            </button>
            <button
              type="button"
              className="tool"
              onClick={() => act({ type: "redo" })}
              disabled={!game.future?.length}
            >
              <Redo />
              <span>進む</span>
            </button>
            <button type="button" className="tool" onClick={() => act({ type: "erase" })}>
              <Eraser />
              <span>消す</span>
            </button>
          </div>
          <NumberPad game={game} showRemaining={false} onDigit={(digit) => act({ type: "input", digit })} />
          <button
            type="button"
            className="btn primary entry-start"
            disabled={!result?.ok}
            onClick={() => {
              if (!result?.ok) return;
              sfx.tap();
              onStart(result.puzzle);
            }}
          >
            始める
          </button>
        </div>
      </div>
    </div>
  );
}
