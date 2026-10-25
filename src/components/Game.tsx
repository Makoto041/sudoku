"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { sfx } from "@/lib/audio";
import { DIFFICULTY_LABEL, serializeGrid } from "@/lib/sudoku/core";
import {
  activeMistakeLimit,
  elapsedOf,
  formatTime,
  isInProgress,
  stuckCells,
  type GameState,
} from "@/lib/game/state";
import { api, ApiError, describeError, type SubmitResponse } from "@/lib/client/api";
import type { Player } from "@/lib/client/player";
import type { Settings } from "@/lib/client/settings";
import { KEYS, load, save } from "@/lib/client/storage";
import { useGame } from "@/lib/client/useGame";
import { useGameKeys } from "@/lib/client/useGameKeys";
import { useStuckAlert } from "@/lib/client/useStuckAlert";
import { recordFreeClear, type FreeClear } from "@/lib/client/stats";
import type { Achievement } from "@/lib/client/achievements";
import { formatPoints } from "@/lib/game/score";
import { Board } from "./Board";
import { NumberPad, Tools } from "./Controls";
import { HintPanel, applyHint, firstStage, hintHighlight, useHintAnnouncement } from "./HintPanel";
import { Failed, Result } from "./Result";
import { ConfirmSheet } from "./Sheets";
import { findHint, type Hint } from "@/lib/sudoku/hint";
import { ChevronLeft, Gear, Pause, Play } from "./icons";

type Props = {
  initial: GameState;
  settings: Settings;
  player: Player;
  /** クリアを端末に記録した後に呼ぶ。実績を判定して、新しく解除したものを返す */
  onCleared: () => Achievement[];
  /** フリープレイの問題を作っている */
  generating: boolean;
  onExit: () => void;
  onOpenSettings: () => void;
  onRanking: (game: GameState) => void;
  onNewFree: (game: GameState) => void;
  /** ミスが上限に達した問題を、同じ盤面で新しく始める */
  onRetry: (game: GameState) => void;
};

export type DailyOutcome =
  | { state: "submitting" }
  | { state: "done"; result: SubmitResponse }
  | { state: "error"; message: string; retry: boolean };

export function Game({
  initial,
  settings,
  player,
  onCleared,
  generating,
  onExit,
  onOpenSettings,
  onRanking,
  onNewFree,
  onRetry,
}: Props) {
  const { game, fx, dispatch, announce } = useGame(initial, {
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
      setHint({ data, stage: firstStage(data) });
    },
    [dispatch],
  );
  const openHint = useCallback(() => {
    const g = gameRef.current;
    if (g.mode === "daily" || !g.solution || g.status !== "playing") return;
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
  const onApplyHint = () => {
    if (!hint) return;
    setHint(null);
    applyHint(hint.data, game, dispatch);
  };
  const hintCells = useMemo(() => hintHighlight(hint), [hint]);
  useHintAnnouncement(hint, announce);

  const [outcome, setOutcome] = useState<DailyOutcome | null>(() => {
    if (initial.mode !== "daily" || !initial.daily) return null;
    const saved = load<SubmitResponse>(KEYS.dailyResult(initial.daily.date, initial.difficulty));
    return saved ? { state: "done", result: saved } : null;
  });
  const [freeClear, setFreeClear] = useState<FreeClear | null>(null);
  // クリアして新しく解除した実績。端末の記録を更新した直後に判定する（解除は保存するので、同じ実績は 2 回出ない）
  const [fresh, setFresh] = useState<Achievement[]>([]);
  const checkAchievements = useCallback(() => {
    let newlyUnlocked: Achievement[] = [];
    try {
      newlyUnlocked = onCleared();
    } catch {
      // 実績はおまけなので、判定が例外を投げても（想定していない保存データなど）実績を出さないだけにして、
      // 送信の成功・フリープレイの記録・結果の表示は続ける。ここで止まった実績は次の判定で解除される
    }
    if (newlyUnlocked.length) setFresh((a) => [...a, ...newlyUnlocked]);
  }, [onCleared]);
  // 結果（クリア・ミスの上限）。終えた問題を開き直したときはすぐ出す
  const [showResult, setShowResult] = useState(!isInProgress(initial));
  const [dismissed, setDismissed] = useState(false);
  // 同じ盤面でやり直すのは 1 回だけ（続けて押すと、始めた数を二重に数える）
  const retried = useRef(false);
  const retry = () => {
    if (retried.current) return;
    retried.current = true;
    sfx.tap();
    onRetry(game);
  };

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
        checkAchievements();
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
            checkAchievements();
            setOutcome({ state: "done", result });
            return;
          }
        }
        const retry = !(err instanceof ApiError) || err.status === 0 || err.status >= 500;
        setOutcome({ state: "error", message: describeError(err), retry });
      }
    },
    [player, checkAchievements],
  );

  // クリアしたら記録する。日次はサーバーに送って順位を受け取る。練習は記録しない。
  // ミスが上限に達して終えた問題（failed）はクリアではないので、記録（クリア数・時間・実績）に数えない
  // （途中でやめた時間には、次に新しく始めたときに足す。App の beginFree）
  const handled = useRef(initial.status === "solved");
  useEffect(() => {
    if (game.status !== "solved" || handled.current) return;
    handled.current = true;
    if (game.mode === "daily") void submit(game);
    else if (game.mode === "free") {
      setFreeClear(
        recordFreeClear(game.difficulty, game.elapsedMs, game.score?.points ?? 0, game.mistakes, game.hints),
      );
      checkAchievements();
    }
  }, [game, submit, checkAchievements]);

  // 盤面のアニメーション（解き終えた波・間違いの揺れ）を見せてから結果を出す
  const ended = !isInProgress(game);
  const initialEnded = !isInProgress(initial);
  useEffect(() => {
    if (!ended || initialEnded) return;
    const t = setTimeout(() => setShowResult(true), 900);
    return () => clearTimeout(t);
  }, [ended, initialEnded]);

  // 日次で送信前に閉じた場合、開き直したときに送る
  useEffect(() => {
    if (initial.mode === "daily" && initial.status === "solved" && !outcome) void submit(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // キーボード操作。設定などのシートを開いている間は盤面を操作しない
  useGameKeys({ dispatch, game, onHint: openHint });

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
  useStuckAlert(isStuck);

  const isDaily = game.mode === "daily";
  // 今効いているミスの上限（フリープレイで、間違いの表示がオンのときだけ。0 は上限なし）
  const mistakeLimit = activeMistakeLimit(game, settings.showMistakes);
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
        <div className="stat score-stat">
          <span className="stat-label">スコア</span>
          <span key={game.score?.points ?? 0} className="stat-value score-value">
            {formatPoints(game.score?.points ?? 0)}
          </span>
        </div>
        <Clock game={game} />
        <div className="stat stat-end">
          {mistakeLimit ? (
            // 「2/3」は読み上げで日付や分数に読まれうるので、読み上げには言葉で渡す
            <span className="stat-pair mistake-limit">
              <span className="stat-label">ミス</span>
              <span className="stat-value" aria-hidden="true">
                {game.mistakes}/{mistakeLimit}
              </span>
              <span className="sr-only">{`${game.mistakes}回 上限${mistakeLimit}回`}</span>
            </span>
          ) : settings.showMistakes ? (
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
              disabled={!isInProgress(game)}
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
            <HintPanel
              hint={hint.data}
              stage={hint.stage}
              onMore={() => setHint({ ...hint, stage: 2 })}
              onApply={onApplyHint}
              onClose={() => setHint(null)}
            />
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
          fresh={fresh}
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
      {showResult && game.status === "failed" && <Failed game={game} onRetry={retry} onHome={onExit} />}
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
    <div className="clock" role="timer" aria-label="経過時間">
      {formatTime(elapsedOf(game))}
    </div>
  );
}

export function shortDate(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}
