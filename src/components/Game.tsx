"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL, serializeGrid } from "@/lib/sudoku/core";
import { elapsedOf, formatTime, stuckCells, type GameState } from "@/lib/game/state";
import { api, ApiError, describeError, type SubmitResponse } from "@/lib/client/api";
import type { Player } from "@/lib/client/player";
import type { Settings } from "@/lib/client/settings";
import { KEYS, load, save } from "@/lib/client/storage";
import { useGame } from "@/lib/client/useGame";
import { recordFreeClear, type FreeClear } from "@/lib/client/stats";
import { formatPoints } from "@/lib/game/score";
import { haptic } from "@/lib/haptics";
import { Board } from "./Board";
import { NumberPad, Tools } from "./Controls";
import { Result } from "./Result";
import { ConfirmSheet } from "./Sheets";
import { findHint, notesAfterHint, type Hint } from "@/lib/sudoku/hint";
import { ChevronLeft, Close, Gear, Pause, Play } from "./icons";

type Props = {
  initial: GameState;
  settings: Settings;
  player: Player;
  /** フリープレイの問題を作っている */
  generating: boolean;
  onExit: () => void;
  onOpenSettings: () => void;
  onRanking: (game: GameState) => void;
  onNewFree: (game: GameState) => void;
};

export type DailyOutcome =
  | { state: "submitting" }
  | { state: "done"; result: SubmitResponse }
  | { state: "error"; message: string; retry: boolean };

export function Game({
  initial,
  settings,
  player,
  generating,
  onExit,
  onOpenSettings,
  onRanking,
  onNewFree,
}: Props) {
  const { game, fx, dispatch } = useGame(initial, {
    showMistakes: settings.showMistakes,
    autoClearNotes: settings.autoClearNotes,
  });
  const gameRef = useRef(game);
  gameRef.current = game;

  // 手筋ヒント：1 段目は手筋の名前と注目する場所、2 段目で根拠と結果、そこで置く／メモに反映
  const [hint, setHint] = useState<{ data: Hint; stage: 1 | 2 } | null>(null);
  // 「ヒントの前に確認」がオンのとき、確認を待っているヒント
  const [pendingHint, setPendingHint] = useState<Hint | null>(null);
  const showHint = useCallback(
    (data: Hint) => {
      dispatch({ type: "hintUsed" });
      sfx.hint(5);
      setHint({ data, stage: data.kind === "wrong" || data.kind === "guess" ? 2 : 1 });
    },
    [dispatch],
  );
  const openHint = useCallback(() => {
    const g = gameRef.current;
    if (g.mode !== "free" || !g.solution || g.status !== "playing") return;
    if (hint) {
      setHint(null);
      sfx.tap();
      return;
    }
    const data = findHint(g.puzzle, g.values, g.notes, g.solution);
    if (!data) {
      sfx.blocked();
      return;
    }
    if (settings.confirmHint) {
      sfx.tap();
      setPendingHint(data);
      return;
    }
    showHint(data);
  }, [hint, settings.confirmHint, showHint]);
  const acceptHint = () => {
    // 確認中に一時停止していたら開かない
    if (pendingHint && gameRef.current.status === "playing") showHint(pendingHint);
    setPendingHint(null);
  };
  // 盤面かメモが変わったらヒントは古くなるので閉じる。色を変えただけなら閉じない（ヒントのマスに色を付けられるように）
  useEffect(() => setHint(null), [game.values, game.notes]);
  const applyHint = () => {
    if (!hint) return;
    const h = hint.data;
    setHint(null);
    if (h.kind === "place" || h.kind === "guess") dispatch({ type: "hint", cell: h.cell });
    else if (h.kind === "eliminate")
      dispatch({ type: "setNotes", notes: notesAfterHint(game.values, game.notes, h.eliminations) });
    else if (h.kind === "wrong") {
      dispatch({ type: "select", cell: h.cell });
      // 色モードでも色ではなく数字を消す
      dispatch({ type: "erase", colors: false });
    }
  };
  const hintCells = useMemo(() => {
    if (!hint) return null;
    const h = hint.data;
    const pattern = "pattern" in h && hint.stage === 2 ? h.pattern : [];
    return {
      focus: new Set(h.focus),
      pattern: new Set(pattern),
      targets: new Set(hint.stage === 2 ? h.targets : []),
    };
  }, [hint]);

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
          moves: g.moves ?? [],
        });
        save(KEYS.dailyResult(g.daily.date, g.difficulty), result);
        setOutcome({ state: "done", result });
        sfx.ranked();
      } catch (err) {
        // 記録済みなら、ランキングから自分の順位を取って表示する
        if (err instanceof ApiError && err.status === 409) {
          const board = await api
            .leaderboard({
              scope: "daily",
              difficulty: g.difficulty,
              date: g.daily.date,
              playerId: player.id,
            })
            .catch(() => null);
          if (board?.me) {
            const result = {
              date: g.daily.date,
              difficulty: g.difficulty,
              timeMs: board.me.timeMs,
              points: board.me.points,
              rank: board.me.rank,
              total: board.total,
            };
            save(KEYS.dailyResult(g.daily.date, g.difficulty), result);
            setOutcome({ state: "done", result });
            return;
          }
        }
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
    else
      setFreeClear(
        recordFreeClear(game.difficulty, game.elapsedMs, game.score?.points ?? 0, game.mistakes, game.hints),
      );
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
      if (target?.closest("input, textarea") || e.metaKey || e.altKey) return;
      // 設定などのシートを開いている間は盤面を操作しない
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // フォーカス中のボタンは Space/Enter で押せるようにし、一時停止に回さない
      if ((e.key === " " || e.key === "Enter") && target?.closest("button")) return;
      const key = e.key.toLowerCase();
      // Shift を先に見る（Ctrl+Shift+Z を元に戻すにしない）
      const isRedo = (key === "z" && e.shiftKey) || (e.ctrlKey && key === "y");
      if (isRedo) {
        e.preventDefault();
        dispatch({ type: "redo" });
        return;
      }
      if (e.ctrlKey && key === "z") {
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
        case "c":
        case "C":
          dispatch({ type: "toggleColors" });
          sfx.tap();
          break;
        case "z":
        case "u":
          dispatch({ type: "undo" });
          break;
        case "h":
          openHint();
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
  }, [dispatch, game.status, openHint]);

  const onSelect = useCallback(
    (cell: number) => {
      dispatch({ type: "select", cell });
      sfx.select();
    },
    [dispatch],
  );
  // 選択が変わらなかったとき（選んであるマスをなぞったなど）は鳴らさない
  const onToggle = useCallback(
    (cell: number) => {
      if (dispatch({ type: "toggleSelection", cell })) sfx.select();
    },
    [dispatch],
  );
  const onExtend = useCallback(
    (cell: number) => {
      if (dispatch({ type: "extendSelection", cell })) sfx.select();
    },
    [dispatch],
  );

  // 入る数字が無いマスが出たら、どこかで間違えているので知らせる
  const stuck = useMemo(() => new Set(stuckCells(game)), [game]);
  const isStuck = stuck.size > 0;
  const wasStuck = useRef(isStuck);
  useEffect(() => {
    if (isStuck && !wasStuck.current) {
      sfx.error();
      haptic("medium");
    }
    wasStuck.current = isStuck;
  }, [isStuck]);

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
        <div className="stat score-stat" aria-label="スコア">
          <span className="stat-label">スコア</span>
          <span key={game.score?.points ?? 0} className="stat-value score-value">
            {formatPoints(game.score?.points ?? 0)}
          </span>
        </div>
        <Clock game={game} />
        <div className="stat stat-end">
          {settings.showMistakes ? (
            <span className="stat-pair">
              <span className="stat-label">ミス</span>
              <span className="stat-value">{game.mistakes}</span>
            </span>
          ) : (
            <span className="stat-pair">
              <span className="stat-value">{Math.round((filled / Math.max(1, toFill)) * 100)}%</span>
            </span>
          )}
          {isDaily ? (
            <span className="live-chip" role="img" aria-label="ランキング戦">
              <span className="live-dot" />
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
            highlightPeers={settings.highlightPeers}
            unitFx={settings.unitFx}
            stuck={stuck}
            hint={hintCells}
            onSelect={onSelect}
            onToggle={onToggle}
            onExtend={onExtend}
          />
          <div className="popups" aria-hidden="true">
            {fx.popups.map((p) => (
              <span
                key={p.id}
                className={`popup ${p.kind}`}
                style={{ "--r": Math.floor(p.cell / 9), "--c": p.cell % 9 } as CSSProperties}
              >
                {p.text}
              </span>
            ))}
          </div>
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
          {hint && (
            <div className="hint-panel" role="status">
              <div className="hint-text">
                <span className="hint-title">{hint.data.title}</span>
                {hint.stage === 2 && <span className="hint-body">{hint.data.text}</span>}
              </div>
              <div className="hint-actions">
                {hint.stage === 1 ? (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      sfx.tap();
                      setHint({ ...hint, stage: 2 });
                    }}
                  >
                    もっと見る
                  </button>
                ) : (
                  <button type="button" className="btn small primary" onClick={applyHint}>
                    {hint.data.kind === "eliminate"
                      ? "メモに反映"
                      : hint.data.kind === "wrong"
                        ? "消す"
                        : hint.data.kind === "guess"
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
                    setHint(null);
                  }}
                >
                  <Close size={18} />
                </button>
              </div>
            </div>
          )}
          {isStuck && (
            <div className="stuck-bar" role="alert">
              <span>どこかで間違えています</span>
              <button type="button" className="btn small" onClick={() => dispatch({ type: "rewind" })}>
                間違える前まで戻す
              </button>
            </div>
          )}
          <Tools
            game={game}
            onUndo={() => dispatch({ type: "undo" })}
            onRedo={() => dispatch({ type: "redo" })}
            onErase={() => dispatch({ type: "erase" })}
            onToggleNotes={() => {
              dispatch({ type: "toggleNotes" });
              sfx.tap();
            }}
            onToggleColors={() => {
              dispatch({ type: "toggleColors" });
              sfx.tap();
            }}
            onHint={openHint}
            onAutoNotes={() => dispatch({ type: "autoNotes" })}
          />
          <NumberPad
            game={game}
            showRemaining={settings.showRemaining}
            onDigit={(digit) => dispatch({ type: "input", digit })}
          />
        </div>
      </div>

      {pendingHint && (
        <ConfirmSheet
          title="ヒントを見ますか？"
          body="コンボが切れます。"
          confirm="見る"
          onConfirm={acceptHint}
          onClose={() => setPendingHint(null)}
        />
      )}

      {showResult && game.status === "solved" && (
        <Result
          game={game}
          outcome={outcome}
          freeClear={freeClear}
          generating={generating}
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
