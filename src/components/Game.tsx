"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL, serializeGrid } from "@/lib/sudoku/core";
import { elapsedOf, formatTime, type GameState } from "@/lib/game/state";
import { api, ApiError, describeError, type SubmitResponse } from "@/lib/client/api";
import type { Player } from "@/lib/client/player";
import type { Settings } from "@/lib/client/settings";
import { KEYS, load, save } from "@/lib/client/storage";
import { useGame } from "@/lib/client/useGame";
import { recordFreeClear, type FreeClear } from "@/lib/client/stats";
import { Board } from "./Board";
import { NumberPad, Tools } from "./Controls";
import { Result } from "./Result";
import { ChevronLeft, Gear, Pause, Play } from "./icons";

type Props = {
  initial: GameState;
  settings: Settings;
  player: Player;
  onExit: () => void;
  onOpenSettings: () => void;
  onRanking: (game: GameState) => void;
  onNewFree: (game: GameState) => void;
};

export type DailyOutcome =
  | { state: "submitting" }
  | { state: "done"; result: SubmitResponse }
  | { state: "error"; message: string; retry: boolean };

export function Game({ initial, settings, player, onExit, onOpenSettings, onRanking, onNewFree }: Props) {
  const { game, fx, dispatch } = useGame(initial, { showMistakes: settings.showMistakes });
  const [outcome, setOutcome] = useState<DailyOutcome | null>(() => {
    if (initial.mode !== "daily" || !initial.daily) return null;
    const saved = load<SubmitResponse>(KEYS.dailyResult(initial.daily.date, initial.difficulty));
    return saved ? { state: "done", result: saved } : null;
  });
  const [freeClear, setFreeClear] = useState<FreeClear | null>(null);
  const [showResult, setShowResult] = useState(initial.status === "solved");
  const [dismissed, setDismissed] = useState(false);

  const submit = useCallback(
    async (g: GameState) => {
      if (!g.daily) return;
      setOutcome({ state: "submitting" });
      try {
        const result = await api.submit({
          sessionId: g.daily.sessionId,
          playerId: player.id,
          grid: serializeGrid(g.values),
          name: player.name ?? "名無し",
        });
        save(KEYS.dailyResult(g.daily.date, g.difficulty), result);
        setOutcome({ state: "done", result });
        sfx.ranked();
      } catch (err) {
        const retry = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
        setOutcome({ state: "error", message: describeError(err), retry });
      }
    },
    [player],
  );

  // クリアしたら記録する。日次はサーバーに送って順位を受け取る
  const handled = useRef(initial.status === "solved");
  useEffect(() => {
    if (game.status !== "solved" || handled.current) return;
    handled.current = true;
    if (game.mode === "daily") void submit(game);
    else setFreeClear(recordFreeClear(game.difficulty, game.elapsedMs, game.mistakes, game.hints));
  }, [game, submit]);

  // 盤面のアニメーションを見せてから結果を出す
  const solved = game.status === "solved";
  useEffect(() => {
    if (!solved || initial.status === "solved") return;
    const t = setTimeout(() => setShowResult(true), 900);
    return () => clearTimeout(t);
  }, [solved, initial.status]);

  // 日次で送信前に閉じた場合、開き直したときに送る
  useEffect(() => {
    if (initial.mode === "daily" && initial.status === "solved" && !outcome) void submit(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // キーボード操作
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input:not([type=checkbox]), textarea") || e.metaKey || e.altKey) return;
      if (e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if (e.ctrlKey) return;
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^Numpad([1-9])$/.exec(e.code)?.[1];
      if (digit) {
        e.preventDefault();
        dispatch({ type: "input", digit: Number(digit), asNote: e.shiftKey ? true : undefined });
        return;
      }
      const moves: Record<string, [number, number]> = {
        ArrowUp: [-1, 0],
        ArrowDown: [1, 0],
        ArrowLeft: [0, -1],
        ArrowRight: [0, 1],
        w: [-1, 0],
        s: [1, 0],
        a: [0, -1],
        d: [0, 1],
      };
      const mv = moves[e.key];
      if (mv) {
        e.preventDefault();
        dispatch({ type: "move", dr: mv[0], dc: mv[1] });
        sfx.select();
        return;
      }
      switch (e.key) {
        case "Backspace":
        case "Delete":
        case "0":
          e.preventDefault();
          dispatch({ type: "erase" });
          break;
        case "n":
        case "N":
          dispatch({ type: "toggleNotes" });
          sfx.tap();
          break;
        case "z":
        case "u":
          dispatch({ type: "undo" });
          break;
        case "h":
          dispatch({ type: "hint" });
          break;
        case " ":
          e.preventDefault();
          dispatch({ type: game.status === "paused" ? "resume" : "pause" });
          break;
        case "Escape":
          dispatch({ type: "select", cell: null });
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, game.status]);

  const onSelect = useCallback(
    (cell: number) => {
      dispatch({ type: "select", cell });
      sfx.select();
    },
    [dispatch],
  );

  const isDaily = game.mode === "daily";
  const filled = game.values.filter((v, i) => v && !game.puzzle[i]).length;
  const toFill = game.puzzle.filter((v) => !v).length;

  return (
    <div className="screen game">
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onExit} aria-label="ホームに戻る">
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <span className="bar-kicker">
            {isDaily ? `今日の一問 · ${shortDate(game.daily!.date)}` : "フリープレイ"}
          </span>
          <span className="bar-main">{DIFFICULTY_LABEL[game.difficulty]}</span>
        </div>
        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="設定">
          <Gear />
        </button>
      </header>

      <div className="status-row">
        <div className="stat">
          {settings.showMistakes || isDaily ? (
            <>
              <span className="stat-label">ミス</span>
              <span className="stat-value">{game.mistakes}</span>
            </>
          ) : (
            <>
              <span className="stat-label">進み具合</span>
              <span className="stat-value">{Math.round((filled / Math.max(1, toFill)) * 100)}%</span>
            </>
          )}
        </div>
        <Clock game={game} />
        <div className="stat stat-end">
          {isDaily ? (
            <span className="live-chip" title="時間はサーバーで計測され、止められません">
              <span className="live-dot" />
              ランキング戦
            </span>
          ) : (
            <button
              type="button"
              className="icon-btn small"
              onClick={() => {
                dispatch({ type: game.status === "paused" ? "resume" : "pause" });
                sfx.tap();
              }}
              disabled={game.status === "solved"}
              aria-label={game.status === "paused" ? "再開" : "一時停止"}
            >
              {game.status === "paused" ? <Play size={18} /> : <Pause size={18} />}
            </button>
          )}
        </div>
      </div>

      <div className="game-body">
        <div className="board-wrap">
          <Board
            game={game}
            fx={fx}
            showMistakes={settings.showMistakes}
            highlightSame={settings.highlightSame}
            onSelect={onSelect}
          />
          {game.status === "paused" && (
            <button
              type="button"
              className="paused"
              onClick={() => {
                dispatch({ type: "resume" });
                sfx.tap();
              }}
            >
              <span className="paused-icon">
                <Play size={28} />
              </span>
              <span>タップして再開</span>
            </button>
          )}
        </div>

        <div className="controls">
          <Tools
            game={game}
            onUndo={() => dispatch({ type: "undo" })}
            onErase={() => dispatch({ type: "erase" })}
            onToggleNotes={() => {
              dispatch({ type: "toggleNotes" });
              sfx.tap();
            }}
            onHint={() => dispatch({ type: "hint" })}
          />
          <NumberPad game={game} onDigit={(digit) => dispatch({ type: "input", digit })} />
        </div>
      </div>

      {showResult && game.status === "solved" && (
        <Result
          game={game}
          outcome={outcome}
          freeClear={freeClear}
          onRetrySubmit={() => void submit(game)}
          onRanking={() => onRanking(game)}
          onHome={onExit}
          onNewFree={() => onNewFree(game)}
          onClose={() => {
            setShowResult(false);
            setDismissed(true);
          }}
        />
      )}
      {dismissed && !showResult && (
        <button
          type="button"
          className="result-reopen"
          onClick={() => {
            setShowResult(true);
            setDismissed(false);
          }}
        >
          結果を見る
        </button>
      )}
    </div>
  );
}

function Clock({ game }: { game: GameState }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (game.mode !== "daily" || game.status === "solved") return;
    const id = setInterval(() => force((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [game.mode, game.status]);
  return (
    <div className="clock" aria-label="経過時間">
      {formatTime(elapsedOf(game))}
    </div>
  );
}

export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}
