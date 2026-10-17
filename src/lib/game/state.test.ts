import { describe, expect, it } from "vitest";
import { bitCount, candidatesAt, digitsOf, findConflicts, parseGrid } from "@/lib/sudoku/core";
import { generatePuzzle } from "@/lib/sudoku/generator";
import { createRng } from "@/lib/sudoku/rng";
import { countSolutions } from "@/lib/sudoku/solver";
import { scoreMoves } from "./score";
import {
  elapsedOf,
  formatTime,
  isGiven,
  isSolved,
  newGame,
  reduce,
  stuckCells,
  withSolution,
  type Action,
  type GameState,
} from "./state";

function freeGame() {
  const p = generatePuzzle("state-test", "easy");
  return {
    p,
    s: newGame({ mode: "free", difficulty: "easy", seed: "x", puzzle: p.puzzle, solution: p.solution }),
  };
}

function run(s: GameState, ...actions: Action[]) {
  let effects: ReturnType<typeof reduce>[1] = [];
  for (const a of actions) [s, effects] = reduce(s, a);
  return { s, effects };
}

// 空きマス cell と、同じ行の空きマス peer の両方に、cell の正解をメモしておく（cell を選んだ状態で返す）
function withNotes() {
  const { p, s: s0 } = freeGame();
  const cell = p.puzzle.indexOf(0);
  const digit = p.solution[cell];
  const peer = p.puzzle.findIndex(
    (v, i) => v === 0 && i !== cell && Math.floor(i / 9) === Math.floor(cell / 9),
  );
  const { s } = run(
    s0,
    { type: "select", cell: peer },
    { type: "input", digit, asNote: true },
    { type: "select", cell },
    { type: "input", digit, asNote: true },
  );
  return { p, s, cell, digit, peer };
}

describe("game reducer", () => {
  it("正しい数字を置くと周りのメモが消え、元に戻すと復元する", () => {
    const { s, cell, digit, peer } = withNotes();
    expect(s.notes[peer]).toBe(1 << digit);
    const placed = run(s, { type: "input", digit });
    expect(placed.s.values[cell]).toBe(digit);
    expect(placed.s.notes[peer]).toBe(0);
    expect(placed.effects[0]).toMatchObject({ kind: "place", wrong: false });
    const undone = run(placed.s, { type: "undo" }).s;
    expect(undone.values[cell]).toBe(0);
    expect(undone.notes).toEqual(s.notes);
  });

  it("間違いはミスとして数え、ヒントは正解を置く", () => {
    const { p, s: s0 } = freeGame();
    const cell = p.puzzle.indexOf(0);
    const wrongDigit = (p.solution[cell] % 9) + 1;
    const { s, effects } = run(s0, { type: "select", cell }, { type: "input", digit: wrongDigit });
    expect(effects[0]).toMatchObject({ kind: "place", wrong: true });
    expect(s.mistakes).toBe(1);
    const hinted = run(s, { type: "hint" }).s;
    expect(hinted.values[cell]).toBe(p.solution[cell]);
    expect(hinted.hints).toBe(1);
  });

  it("ヒントのマスは変更できない", () => {
    const { p, s: s0 } = freeGame();
    const given = p.puzzle.findIndex((v) => v !== 0);
    const { s, effects } = run(s0, { type: "select", cell: given }, { type: "input", digit: 1 });
    expect(s.values[given]).toBe(p.puzzle[given]);
    expect(effects[0].kind).toBe("blocked");
  });

  it("すべて埋めると solved になり、以降の入力は無視する", () => {
    const { p, s: s0 } = freeGame();
    let s = s0;
    let last: ReturnType<typeof reduce>[1] = [];
    for (let i = 0; i < 81; i++) {
      if (p.puzzle[i]) continue;
      [s, last] = reduce(s, { type: "select", cell: i });
      [s, last] = reduce(s, { type: "input", digit: p.solution[i] });
    }
    expect(s.status).toBe("solved");
    expect(last.some((e) => e.kind === "solved")).toBe(true);
    expect(run(s, { type: "undo" }).s).toBe(s);
    expect(reduce(s, { type: "redo" })).toEqual([s, []]);
  });

  it("日次は解答なしで重複を間違いとみなし、ヒントは使えない", () => {
    const p = generatePuzzle("daily-test", "easy");
    const s0 = newGame({
      mode: "daily",
      difficulty: "easy",
      seed: "2026-10-15",
      puzzle: p.puzzle,
      solution: null,
      daily: { sessionId: "s", date: "2026-10-15", startedAt: 1000, clockOffset: 0 },
    });
    const cell = p.puzzle.indexOf(0);
    const rowDigit = p.puzzle.find((v, i) => v && Math.floor(i / 9) === Math.floor(cell / 9))!;
    const { s, effects } = run(s0, { type: "select", cell }, { type: "input", digit: rowDigit });
    expect(effects[0]).toMatchObject({ kind: "place", wrong: true });
    expect(run(s, { type: "hint" }).effects[0].kind).toBe("blocked");
    expect(elapsedOf(s, 61_000)).toBe(60_000);
    expect(run(s, { type: "pause" }).s.status).toBe("playing");
  });

  it("時間の表示", () => {
    expect(formatTime(65_000)).toBe("01:05");
    expect(formatTime(3_725_000)).toBe("1:02:05");
  });
});

describe("周りのメモの自動消去（設定）", () => {
  it("オフでは周りのメモを残し、点数はオンと同じ。元に戻すと置く前の盤面とメモに戻る", () => {
    const { s, cell, digit, peer } = withNotes();
    const on = run(s, { type: "input", digit, t: 1000 });
    // 省略時はオンと同じ
    expect(run(s, { type: "input", digit, t: 1000, clearPeers: true }).s).toEqual(on.s);
    const off = run(s, { type: "input", digit, t: 1000, clearPeers: false });
    expect(on.s.notes[peer]).toBe(0);
    expect(off.s.notes[peer]).toBe(1 << digit);
    expect(off.s.values[cell]).toBe(digit);
    // 置いたマス自身のメモは消す
    expect(off.s.notes[cell]).toBe(0);
    expect(off.s.score).toEqual(on.s.score);
    expect(off.effects).toEqual(on.effects);
    const undone = run(off.s, { type: "undo" }).s;
    expect(undone.values).toEqual(s.values);
    expect(undone.notes).toEqual(s.notes);
    expect(undone.history).toHaveLength(s.history.length);
  });

  it("オフでもメモを書いてから解き切ると、メモは残らない", () => {
    const { p, s: s0 } = freeGame();
    let { s } = run(s0, { type: "autoNotes" });
    for (let i = 0; i < 81; i++) {
      if (p.puzzle[i]) continue;
      s = run(s, { type: "select", cell: i }, { type: "input", digit: p.solution[i], clearPeers: false }).s;
    }
    expect(s.status).toBe("solved");
    expect(s.notes.every((n) => n === 0)).toBe(true);
  });

  it("ヒントで置くときもオフなら周りのメモを残す", () => {
    const { s, cell, digit, peer } = withNotes();
    const off = run(s, { type: "hintUsed" }, { type: "hint", cell, clearPeers: false }).s;
    const on = run(s, { type: "hintUsed" }, { type: "hint", cell }).s;
    expect(off.values[cell]).toBe(digit);
    expect(off.notes[peer]).toBe(1 << digit);
    expect(on.notes[peer]).toBe(0);
  });
});

describe("行き詰まり", () => {
  // 2026-10-16 のエキスパート（旧生成コード）と、重複は無いが解けなくなった実際の盤面
  const PUZZLE = parseGrid(
    "000009000030020010709000506600003070003702600050400008901000307080040020000100000",
  );
  const STUCK = parseGrid(
    "164579283835624719729831546618953472403782695257406138941268357586347921372195864",
  );

  function play(values: number[]) {
    let s = newGame({
      mode: "daily",
      difficulty: "expert",
      seed: "2026-10-16",
      puzzle: PUZZLE,
      solution: null,
      daily: { sessionId: "s", date: "2026-10-16", startedAt: 0, clockOffset: 0 },
    });
    for (let i = 0; i < 81; i++) {
      if (PUZZLE[i] || !values[i]) continue;
      [s] = reduce(s, { type: "select", cell: i });
      [s] = reduce(s, { type: "input", digit: values[i] });
    }
    return s;
  }

  it("入る数字が無いマスを見つける", () => {
    const s = play(STUCK);
    expect(findConflicts(s.values).size).toBe(0);
    expect(stuckCells(s).sort((a, b) => a - b)).toEqual([37, 49]);
  });

  it("間違える前まで戻すと、解ける盤面に戻る", () => {
    const s = play(STUCK);
    const [back, effects] = reduce(s, { type: "rewind" });
    expect(effects[0]).toMatchObject({ kind: "rewind" });
    expect(back.history.length).toBeLessThan(s.history.length);
    expect(countSolutions(back.values, 1)).toBe(1);
    expect(stuckCells(back)).toEqual([]);
    // 解ける盤面では何もしない
    expect(reduce(back, { type: "rewind" })[1][0].kind).toBe("blocked");
  });

  it("間違える前まで戻したあとは、進むで行き詰まった盤面に戻れない", () => {
    const undone = run(play(STUCK), { type: "undo" }).s;
    expect(undone.future).toHaveLength(1);
    const { s: back, effects } = run(undone, { type: "rewind" });
    expect(effects[0]).toMatchObject({ kind: "rewind" });
    expect(back.future).toEqual([]);
    expect(run(back, { type: "redo" }).effects[0].kind).toBe("blocked");
  });

  it("行き詰まっていなければ何も返さない", () => {
    expect(stuckCells(play(Array(81).fill(0)))).toEqual([]);
  });
});

describe("日次の間違い表示", () => {
  it("端末で解いた解答と照合し、重複しない間違いも間違いとして扱う。ヒントは使えない", () => {
    const p = generatePuzzle("daily-wrong", "hard");
    const s0 = withSolution(
      newGame({
        mode: "daily",
        difficulty: "hard",
        seed: "2026-10-16",
        puzzle: p.puzzle,
        solution: null,
        daily: { sessionId: "s", date: "2026-10-16", startedAt: 0, clockOffset: 0 },
      }),
    );
    expect(s0.solution).toEqual(p.solution);
    // 候補が 2 つ以上あるマスに、解答ではない候補を入れる（重複はしない）
    const cell = p.puzzle.findIndex((v, i) => !v && bitCount(candidatesAt(p.puzzle, i)) >= 2);
    const wrongDigit = digitsOf(candidatesAt(p.puzzle, cell)).find((d) => d !== p.solution[cell])!;
    const { s, effects } = run(s0, { type: "select", cell }, { type: "input", digit: wrongDigit });
    expect(effects[0]).toMatchObject({ kind: "place", wrong: true, conflict: false });
    expect(s.mistakes).toBe(1);
    expect(run(s, { type: "hint" }).effects[0].kind).toBe("blocked");
  });
});

describe("自動メモと手筋ヒント", () => {
  it("自動メモは候補をすべて書き、もう一度で全部消す。元に戻すで戻る", () => {
    const { p, s: s0 } = freeGame();
    const cell = p.puzzle.indexOf(0);
    let { s } = run(s0, { type: "select", cell }, { type: "input", digit: 1, asNote: true });
    const before = s.notes.slice();
    const filled = run(s, { type: "autoNotes" });
    expect(filled.effects[0]).toMatchObject({ kind: "notes", filled: true });
    expect(filled.s.notes[cell] & (1 << p.solution[cell])).not.toBe(0);
    expect(filled.s.notes.filter((n, i) => !p.puzzle[i] && n === 0)).toHaveLength(0);
    const cleared = run(filled.s, { type: "autoNotes" });
    expect(cleared.s.notes.every((n) => n === 0)).toBe(true);
    s = run(cleared.s, { type: "undo" }, { type: "undo" }).s;
    expect(s.notes).toEqual(before);
  });

  it("ヒントで指定したマスに正解を置き、0 点でコンボが切れる", () => {
    const { p, s: s0 } = freeGame();
    const cell = p.puzzle.lastIndexOf(0);
    const { s, effects } = run(s0, { type: "hintUsed" }, { type: "hint", cell });
    expect(s.values[cell]).toBe(p.solution[cell]);
    // ヒントを開いたときに 1 回数え、パネルから置いても増やさない
    expect(s.hints).toBe(1);
    expect(effects[0]).toMatchObject({ kind: "hint", cell });
    expect(s.score?.streak).toBe(0);
  });

  it("日次では自動メモもヒントも使えない", () => {
    const p = generatePuzzle("daily-assist", "easy");
    const s0 = newGame({
      mode: "daily",
      difficulty: "easy",
      seed: "2026-10-16",
      puzzle: p.puzzle,
      solution: p.solution,
      daily: { sessionId: "s", date: "2026-10-16", startedAt: 0, clockOffset: 0 },
    });
    for (const a of [
      { type: "autoNotes" },
      { type: "hintUsed" },
      { type: "setNotes", notes: [] },
    ] as Action[]) {
      expect(run(s0, a).effects[0].kind).toBe("blocked");
    }
  });
});

describe("進む（元に戻した手のやり直し）", () => {
  // 元に戻す前と、戻して進んだ後で同じであるべきもの
  const kept = (s: GameState) => ({
    values: s.values,
    notes: s.notes,
    history: s.history,
    score: s.score,
    moves: s.moves,
    mistakes: s.mistakes,
    hints: s.hints,
  });

  function dailyGame(seed: string, difficulty: "easy" | "medium" = "easy") {
    const p = generatePuzzle(seed, difficulty);
    const s = withSolution(
      newGame({
        mode: "daily",
        difficulty,
        seed: "2026-10-17",
        puzzle: p.puzzle,
        solution: null,
        daily: { sessionId: "s", date: "2026-10-17", startedAt: 0, clockOffset: 0 },
      }),
    );
    return { p, s };
  }

  it.each([
    ["オン", true],
    ["オフ", false],
  ] as const)(
    "置いた手を戻して進むと、置いた直後と同じになる（周りのメモの自動消去が%s）",
    (_, clearPeers) => {
      const { s, cell, digit, peer } = withNotes();
      const placed = run(s, { type: "input", digit, t: 1000, clearPeers }).s;
      const undone = run(placed, { type: "select", cell: peer }, { type: "undo" }).s;
      expect(undone.values[cell]).toBe(0);
      expect(undone.notes).toEqual(s.notes);
      expect(undone.future).toHaveLength(1);
      const { s: redone, effects } = run(undone, { type: "select", cell: peer }, { type: "redo" });
      expect(effects).toEqual([{ kind: "redo", cell }]);
      expect(kept(redone)).toEqual(kept(placed));
      expect(redone.notes[peer]).toBe(clearPeers ? 0 : 1 << digit);
      expect(redone.future).toEqual([]);
      // 戻したときと同じく、そのマスを選ぶ
      expect(redone.selected).toBe(cell);
      // もう一度戻すと置く前に戻る
      const again = run(redone, { type: "undo" }).s;
      expect(again.values).toEqual(s.values);
      expect(again.notes).toEqual(s.notes);
    },
  );

  it("間違いを戻して進んでも、ミスと減点は増えない", () => {
    const { p, s: s0 } = freeGame();
    const [a, b] = p.puzzle.flatMap((v, i) => (v ? [] : [i]));
    const wrongDigit = (p.solution[b] % 9) + 1;
    const played = run(
      s0,
      { type: "select", cell: a },
      { type: "input", digit: p.solution[a], t: 1000 },
      { type: "select", cell: b },
      { type: "input", digit: wrongDigit, t: 2000 },
    ).s;
    expect(played.mistakes).toBe(1);
    const undone = run(played, { type: "undo" }, { type: "undo" }).s;
    expect(undone.values[a]).toBe(0);
    expect(undone.future).toHaveLength(2);
    const redone = run(undone, { type: "redo" }, { type: "redo" }).s;
    expect(kept(redone)).toEqual(kept(played));
    expect(redone.future).toEqual([]);
    expect(run(redone, { type: "redo" }).effects[0].kind).toBe("blocked");
  });

  it("メモ・消す・自動メモ・ヒントのメモ反映も、戻した順の逆に進める", () => {
    const { p, s: s0 } = freeGame();
    const cell = p.puzzle.indexOf(0);
    const steps: Action[][] = [
      [
        { type: "select", cell },
        { type: "input", digit: 3, asNote: true },
      ],
      [{ type: "autoNotes" }],
      [{ type: "setNotes", notes: Array(81).fill(1 << 2) }],
      [{ type: "input", digit: p.solution[cell], t: 1000 }],
      [{ type: "erase" }],
      [{ type: "autoNotes" }],
      [{ type: "autoNotes" }],
    ];
    const states = [s0];
    for (const actions of steps) states.push(run(states[states.length - 1], ...actions).s);
    let s = states[states.length - 1];
    expect(s.history).toHaveLength(steps.length);
    for (let k = steps.length - 1; k >= 0; k--) {
      s = run(s, { type: "undo" }).s;
      expect(s.values).toEqual(states[k].values);
      expect(s.notes).toEqual(states[k].notes);
      expect(s.future).toHaveLength(steps.length - k);
    }
    const last = states[steps.length];
    for (let k = 1; k <= steps.length; k++) {
      const selected = s.selected;
      const { s: next, effects } = run(s, { type: "redo" });
      // 盤面とメモと手順はその手の直後に戻り、点数などは元に戻すでも進むでも変わらない
      expect(kept(next)).toEqual({
        ...kept(last),
        values: states[k].values,
        notes: states[k].notes,
        history: states[k].history,
      });
      // まとめて変えたメモは選択を動かさない
      if (next.history[k - 1].bulkNotes) {
        expect(effects).toEqual([{ kind: "redo", cell: -1 }]);
        expect(next.selected).toBe(selected);
      }
      s = next;
    }
    expect(s.future).toEqual([]);
  });

  it("新しい手を打つと進めなくなる。選択・移動・メモ切替・ヒントを見る・一時停止では消えない", () => {
    const { s: base, cell, digit, peer } = withNotes();
    const undone = run(base, { type: "undo" }).s;
    expect(undone.future).toHaveLength(1);
    const keeps: Action[][] = [
      [{ type: "select", cell: peer }],
      [{ type: "select", cell: null }],
      [{ type: "move", dr: 1, dc: 0 }],
      [{ type: "toggleNotes" }],
      [{ type: "hintUsed" }],
      [{ type: "pause" }, { type: "resume" }],
      [{ type: "tick", ms: 500 }],
    ];
    for (const actions of keeps) {
      const s = run(undone, ...actions).s;
      expect(s.future).toBe(undone.future);
      expect(run(s, { type: "redo" }).s.notes).toEqual(base.notes);
    }
    const clears: Action[][] = [
      [{ type: "input", digit }],
      [{ type: "input", digit: 1, asNote: true }],
      [{ type: "select", cell: peer }, { type: "erase" }],
      [{ type: "autoNotes" }],
      [{ type: "setNotes", notes: Array(81).fill(0) }],
      [{ type: "hint", cell }],
    ];
    for (const actions of clears) {
      const s = run(undone, ...actions).s;
      expect(s.history).toHaveLength(undone.history.length + 1);
      expect(s.future).toEqual([]);
      expect(run(s, { type: "redo" }).effects[0].kind).toBe("blocked");
    }
  });

  it("一時停止中は進めない", () => {
    const { s: base } = withNotes();
    const paused = run(base, { type: "undo" }, { type: "pause" }).s;
    expect(paused.future).toHaveLength(1);
    expect(reduce(paused, { type: "redo" })).toEqual([paused, []]);
  });

  it("日次でも使え、進んでも手の記録・点数・ミスは変わらない", () => {
    const { p, s: s0 } = dailyGame("daily-redo");
    const cell = p.puzzle.indexOf(0);
    const wrongDigit = (p.solution[cell] % 9) + 1;
    const played = run(
      s0,
      { type: "select", cell },
      { type: "input", digit: wrongDigit, t: 1000 },
      { type: "input", digit: p.solution[cell], t: 2000 },
    ).s;
    const log = [
      [1000, cell, wrongDigit],
      [2000, cell, p.solution[cell]],
    ];
    expect(played.moves).toEqual(log);
    const undone = run(played, { type: "undo" }, { type: "undo" }).s;
    expect(undone.values[cell]).toBe(0);
    const { s: redone, effects } = run(undone, { type: "redo" }, { type: "redo" });
    expect(effects).toEqual([{ kind: "redo", cell }]);
    expect(kept(redone)).toEqual(kept(played));
    expect(redone.moves).toEqual(log);
  });

  // 盤面とメモを手順ごとに覚えておき、元に戻す・進むがその盤面に戻ることを確かめる
  it.each(["daily", "free"] as const)(
    "ランダムな手順でも盤面が崩れず、日次の点数はサーバーの計算と一致する（%s）",
    (mode) => {
      const board = (g: GameState) => ({ values: g.values, notes: g.notes });
      let redos = 0;
      for (let round = 0; round < 12; round++) {
        const seed = `redo-random-${mode}-${round}`;
        const { p, s: daily } = dailyGame(seed, "medium");
        let s =
          mode === "daily"
            ? daily
            : newGame({ mode, difficulty: "medium", seed, puzzle: p.puzzle, solution: p.solution });
        const rng = createRng(seed);
        const empties = p.puzzle.flatMap((v, i) => (v ? [] : [i]));
        const past: ReturnType<typeof board>[] = [];
        const ahead: ReturnType<typeof board>[] = [];
        let t = 0;
        for (let step = 0; step < 400 && s.status === "playing"; step++) {
          const cell = empties[Math.floor(rng() * empties.length)];
          const digit = 1 + Math.floor(rng() * 9);
          const r = rng();
          const action: Action =
            r < 0.35
              ? { type: "input", digit: rng() < 0.6 ? p.solution[cell] : digit, t: (t += 1000) }
              : r < 0.5
                ? { type: "input", digit, asNote: true }
                : r < 0.57
                  ? { type: "erase" }
                  : r < 0.75
                    ? { type: "undo" }
                    : r < 0.93
                      ? { type: "redo" }
                      : rng() < 0.5
                        ? { type: "autoNotes" }
                        : { type: "hint", cell, t: (t += 1000) };
          const prev = s;
          s = run(s, { type: "select", cell }, action).s;
          if (action.type === "undo" && s.history.length < prev.history.length) {
            ahead.push(board(prev));
            expect(board(s)).toEqual(past.pop());
          } else if (action.type === "redo" && s.history.length > prev.history.length) {
            redos++;
            expect(board(s)).toEqual(ahead.pop());
            past.push(board(prev));
          } else if (s.history.length > prev.history.length) {
            past.push(board(prev));
            ahead.length = 0;
          } else {
            expect(board(s)).toEqual(board(prev));
          }
          expect(s.future ?? []).toHaveLength(ahead.length);
          expect(s.history).toHaveLength(past.length);
          // ヒントのマスは変わらず、数字のあるマスにメモは残らない
          for (let i = 0; i < 81; i++) {
            if (isGiven(s, i)) expect(s.values[i]).toBe(p.puzzle[i]);
            if (s.values[i]) expect(s.notes[i]).toBe(0);
          }
          // 解けた盤面は必ず solved になっている（進むで解けた盤面に戻ることはない）
          expect(isSolved(s)).toBe(s.status === "solved");
          // 解き終えると時間ボーナスが付くので、比べるのは解き終える前まで
          if (mode === "daily" && s.status === "playing") {
            expect(scoreMoves(p.puzzle, p.solution, "medium", s.moves!, Infinity)).toEqual(s.score);
          }
        }
        // 最初まで戻して最後まで進むと、元の盤面と記録に戻る
        if (s.status === "playing") {
          const before = s;
          const n = s.history.length;
          for (let k = 0; k < n; k++) s = run(s, { type: "undo" }).s;
          expect(s.values).toEqual(p.puzzle);
          for (let k = 0; k < n; k++) s = run(s, { type: "redo" }).s;
          expect(kept(s)).toEqual(kept(before));
        }
      }
      expect(redos).toBeGreaterThan(100);
    },
  );
});
