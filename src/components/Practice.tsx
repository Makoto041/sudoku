"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import { newGame, type Action } from "@/lib/game/state";
import type { Settings } from "@/lib/client/settings";
import { useGame } from "@/lib/client/useGame";
import { useGameKeys } from "@/lib/client/useGameKeys";
import { useStuckAlert } from "@/lib/client/useStuckAlert";
import { haptic } from "@/lib/haptics";
import { findHint, type Hint } from "@/lib/sudoku/hint";
import { answerOf, checkPractice, startNotes, type PracticeItem } from "@/lib/sudoku/practice";
import { Board } from "./Board";
import { NumberPad, Tools } from "./Controls";
import { HintPanel, applyHint, firstStage, hintHighlight } from "./HintPanel";
import { Check, ChevronLeft, Gear } from "./icons";

type Props = {
  item: PracticeItem;
  index: number;
  settings: Settings;
  onBack: () => void;
  /** 次の局面へ。最後の局面なら一覧に戻る */
  onNext: () => void;
  onSolved: (id: string) => void;
  onOpenSettings: () => void;
};

/**
 * 手筋の練習の 1 局面。時計・スコア・ミス数・一時停止・得点は出さない。
 * 正解したら盤面はそれ以上変えず、次へ進む
 */
export function Practice({ item, index, settings, onBack, onNext, onSolved, onOpenSettings }: Props) {
  const position = item.positions[index];
  const last = index === item.positions.length - 1;
  const answer = useMemo(() => answerOf(position), [position]);
  const [initial] = useState(() =>
    newGame({
      mode: "practice",
      // 点数は出さないので、難易度は使わない
      difficulty: "easy",
      seed: position.id,
      puzzle: position.values,
      solution: position.solution,
      notes: startNotes(position),
    }),
  );
  // 答え合わせのため、間違いは設定に関わらず見せる。置いた数字は周りのメモから消さない
  // （違う数字を置いてから消すと、周りのメモから正解を消した跡が残るため。正解を置けば局面は終わる）
  const { game, fx, dispatch } = useGame(initial, { showMistakes: true, autoClearNotes: false });
  const gameRef = useRef(game);
  gameRef.current = game;

  const check = useMemo(
    () => checkPractice(position, answer, game.values, game.notes),
    [position, answer, game.values, game.notes],
  );
  // 正解かは盤面とメモだけで決める（ヒントを反映しても、狙いの手になっていなければ正解にしない）
  const solved = check.correct;
  const solvedRef = useRef(solved);
  solvedRef.current = solved;
  // 正解したら盤面を変えない
  const act = useCallback((action: Action) => !solvedRef.current && dispatch(action), [dispatch]);

  useEffect(() => {
    if (!solved) return;
    onSolved(position.id);
    sfx.ranked();
    haptic("medium");
    // 正解は取り消さないので、正解になったときに 1 回だけ記録する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solved]);

  // 正解の数字をメモから消したマスは、行き詰まりと同じ赤い枠で示す（違う数字は盤面が赤くする）。
  // 正解は lost が空のときだけなので、正解の間は枠が出ない
  const lost = useMemo(() => new Set(check.lost), [check.lost]);
  const hasLost = lost.size > 0;
  useStuckAlert(hasLost);
  const problem = solved
    ? null
    : check.wrong.length
      ? "違う数字があります"
      : hasLost
        ? "正解の数字をメモから消しています"
        : null;

  // 答えを見る：手筋の名前 → 説明と対象のマス → 盤面に反映
  const [hint, setHint] = useState<{ data: Hint; stage: 1 | 2 } | null>(null);
  const openHint = useCallback(() => {
    const g = gameRef.current;
    if (solvedRef.current || !g.solution) return;
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
    sfx.hint(5);
    setHint({ data, stage: firstStage(data) });
  }, [hint]);
  // 盤面かメモが変わったらヒントは古くなるので閉じる
  useEffect(() => setHint(null), [game.values, game.notes]);
  const onApplyHint = () => {
    if (!hint) return;
    setHint(null);
    applyHint(hint.data, game, dispatch);
  };
  const hintCells = useMemo(() => hintHighlight(hint), [hint]);

  // 正解したらキーでも盤面を変えず、音も鳴らさない
  useGameKeys({ dispatch: act, game, onHint: openHint, enabled: !solved });

  const onSelect = useCallback(
    (cell: number) => {
      if (solvedRef.current) return;
      dispatch({ type: "select", cell });
      sfx.select();
    },
    [dispatch],
  );
  const onToggle = useCallback(
    (cell: number) => {
      if (act({ type: "toggleSelection", cell })) sfx.select();
    },
    [act],
  );
  const onExtend = useCallback(
    (cell: number) => {
      if (act({ type: "extendSelection", cell })) sfx.select();
    },
    [act],
  );

  return (
    <div className="screen game practice" data-position={position.id}>
      <header className="bar">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="一覧に戻る">
          <ChevronLeft />
        </button>
        <div className="bar-title">
          <span className="bar-kicker">
            手筋の練習 · {index + 1}/{item.positions.length}
          </span>
          <h1 className="bar-main">{item.name}</h1>
        </div>
        <button type="button" className="icon-btn" onClick={onOpenSettings} aria-label="設定">
          <Gear />
        </button>
      </header>

      <div className="status-row practice-status">
        <span>{answer.placement ? "置けるマスに数字を置く" : "消せる候補をメモから消す"}</span>
      </div>

      <div className="game-body">
        <div className="board-wrap">
          <Board
            game={game}
            fx={fx}
            showMistakes
            highlightSame={settings.highlightSame}
            highlightPeers={settings.highlightPeers}
            unitFx={settings.unitFx}
            stuck={lost}
            hint={hintCells}
            onSelect={onSelect}
            onToggle={onToggle}
            onExtend={onExtend}
          />
        </div>

        <div className="controls">
          {solved ? (
            <div className="practice-result" role="status">
              <span className="practice-result-label">
                <Check size={20} />
                正解
              </span>
              <button type="button" className="btn small primary" onClick={onNext}>
                {last ? "一覧に戻る" : "次へ"}
              </button>
            </div>
          ) : (
            <>
              {hint && (
                <HintPanel
                  hint={hint.data}
                  stage={hint.stage}
                  onMore={() => setHint({ ...hint, stage: 2 })}
                  onApply={onApplyHint}
                  onClose={() => setHint(null)}
                />
              )}
              {problem && (
                <div className="stuck-bar" role="alert">
                  <span>{problem}</span>
                </div>
              )}
            </>
          )}
          <Tools
            game={game}
            onUndo={() => act({ type: "undo" })}
            onRedo={() => act({ type: "redo" })}
            onErase={() => act({ type: "erase" })}
            onToggleNotes={() => {
              if (act({ type: "toggleNotes" })) sfx.tap();
            }}
            onToggleColors={() => {
              if (act({ type: "toggleColors" })) sfx.tap();
            }}
            onHint={openHint}
            onAutoNotes={() => act({ type: "autoNotes" })}
          />
          <NumberPad
            game={game}
            showRemaining={settings.showRemaining}
            onDigit={(digit) => act({ type: "input", digit })}
          />
        </div>
      </div>
    </div>
  );
}
