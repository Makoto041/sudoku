"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sfx } from "@/lib/audio";
import { elapsedOf, reduce, type Action, type Effect, type GameState } from "@/lib/game/state";
import { haptic } from "@/lib/haptics";
import { KEYS, save } from "./storage";

/** 盤面アニメーション用の一時的な印 */
export type Fx = {
  pop: { cell: number; key: number } | null;
  shake: { cell: number; key: number } | null;
  /** 揃ったユニットのマスと、波打たせる順番 */
  flash: { cells: Map<number, number>; key: number } | null;
  solvedKey: number | null;
  /** マスの上に浮かべる得点（直近のものだけ残す） */
  popups: Popup[];
};

export type Popup = { id: number; cell: number; text: string; kind: "gain" | "bonus" | "loss" };

const EMPTY_FX: Fx = { pop: null, shake: null, flash: null, solvedKey: null, popups: [] };

export function storageKeyFor(s: GameState): string {
  return s.mode === "daily" && s.daily ? KEYS.daily(s.daily.date, s.difficulty) : KEYS.free;
}

function playEffects(effects: Effect[]) {
  for (const e of effects) {
    switch (e.kind) {
      case "place":
        if (e.wrong) {
          sfx.error();
          haptic("medium");
        } else if (e.units.length) {
          sfx.unit(e.units.length, e.digit);
          haptic("medium");
        } else {
          sfx.place(e.digit);
          haptic("light");
        }
        break;
      case "note":
        sfx.note(e.digit, e.on);
        haptic("light");
        break;
      case "erase":
        sfx.erase();
        haptic("light");
        break;
      case "undo":
        sfx.undo();
        haptic("light");
        break;
      case "rewind":
        sfx.rewind();
        haptic("medium");
        break;
      case "hint":
        if (e.units.length) sfx.unit(e.units.length, e.digit);
        else sfx.hint(e.digit);
        haptic("light");
        break;
      case "solved":
        // 揃った音と重ならないよう少し遅らせる
        setTimeout(() => sfx.solved(), 260);
        haptic("heavy");
        break;
      case "blocked":
        sfx.blocked();
        break;
    }
  }
}

/**
 * ゲームの状態と入力。入力ごとに音・触覚・アニメーションを出し、localStorage に保存する。
 * フリープレイの時計はここで進め、画面が隠れたら自動で一時停止する。
 */
export function useGame(initial: GameState, options: { showMistakes: boolean }) {
  const [game, setGame] = useState(initial);
  const [fx, setFx] = useState<Fx>(EMPTY_FX);
  const gameRef = useRef(game);
  gameRef.current = game;
  const fxKey = useRef(0);

  const dispatch = useCallback(
    (raw: Action) => {
      // 置く操作には経過時間を付ける（スコアの速さに使う）
      const action: Action =
        raw.type === "input" || raw.type === "hint" ? { ...raw, t: elapsedOf(gameRef.current) } : raw;
      const [next, effects] = reduce(gameRef.current, action);
      if (next === gameRef.current && effects.length === 0) return;
      gameRef.current = next;
      setGame(next);
      if (effects.length === 0) return;
      playEffects(
        effects.map((e) =>
          // 「間違いをすぐ表示」がオフのときは、重複していない間違いは普通の音にする
          e.kind === "place" && e.wrong && !options.showMistakes && !e.conflict ? { ...e, wrong: false } : e,
        ),
      );
      const key = ++fxKey.current;
      setFx((prev) => {
        const out: Fx = { ...prev };
        const popups: Popup[] = [];
        for (const e of effects) {
          if (e.kind === "place" && e.points !== 0) {
            const text = e.points > 0 ? `+${e.points}` : `${e.points}`.replace("-", "−");
            popups.push({ id: key * 10, cell: e.cell, text, kind: e.points > 0 ? "gain" : "loss" });
          }
          if ((e.kind === "place" || e.kind === "hint") && e.bonus > 0) {
            popups.push({ id: key * 10 + 1, cell: e.cell, text: `+${e.bonus}`, kind: "bonus" });
          }
          if (e.kind === "place" || e.kind === "hint") {
            out.pop = { cell: e.cell, key };
            // 揺れは間違えたその入力だけ。正しく入れ直したら前の揺れを引き継がない
            out.shake =
              e.kind === "place" && ((e.wrong && options.showMistakes) || e.conflict)
                ? { cell: e.cell, key }
                : null;
            if (e.units.length) {
              const cells = new Map<number, number>();
              for (const unit of e.units) {
                unit.forEach((i, order) => {
                  // 置いたマスから近い順に光らせる
                  const d = Math.abs(unit.indexOf(e.cell) - order);
                  cells.set(i, Math.min(cells.get(i) ?? 99, d));
                });
              }
              out.flash = { cells, key };
            }
          }
          if (e.kind === "solved") {
            out.solvedKey = key;
            if (e.timeBonus > 0) {
              popups.push({ id: key * 10 + 2, cell: e.cell, text: `+${e.timeBonus}`, kind: "bonus" });
            }
          }
        }
        if (popups.length) out.popups = [...prev.popups, ...popups].slice(-6);
        return out;
      });
    },
    [options.showMistakes],
  );

  // フリープレイの時計
  useEffect(() => {
    if (game.mode !== "free" || game.status !== "playing") return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      dispatch({ type: "tick", ms: now - last });
      last = now;
    }, 250);
    return () => clearInterval(id);
  }, [game.mode, game.status, dispatch]);

  // 日次は解き終えた瞬間の時間を固定して表示する
  useEffect(() => {
    if (game.status === "solved" && game.finalMs === null) {
      dispatch({ type: "finalize", ms: elapsedOf(game) });
    }
  }, [game, dispatch]);

  // 画面が隠れたらフリープレイを一時停止
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") dispatch({ type: "pause" });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [dispatch]);

  // 保存。盤面が変わったらすぐ、時計だけの更新は数秒おきに書く
  const lastSaved = useRef<{ game: GameState; at: number } | null>(null);
  useEffect(() => {
    const prev = lastSaved.current;
    const now = Date.now();
    const boardChanged =
      !prev ||
      prev.game.history !== game.history ||
      prev.game.status !== game.status ||
      prev.game.finalMs !== game.finalMs;
    if (!boardChanged && now - prev.at < 3000) return;
    lastSaved.current = { game, at: now };
    save(storageKeyFor(game), { ...game, selected: null });
  }, [game]);
  useEffect(() => {
    const flush = () => save(storageKeyFor(gameRef.current), { ...gameRef.current, selected: null });
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  return { game, fx, dispatch };
}
