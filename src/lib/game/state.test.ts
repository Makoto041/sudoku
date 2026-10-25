import { describe, expect, it } from "vitest";
import {
  PEERS,
  UNITS,
  UNITS_OF,
  bitCount,
  candidatesAt,
  digitsOf,
  findConflicts,
  parseGrid,
} from "@/lib/sudoku/core";
import { generatePuzzle } from "@/lib/sudoku/generator";
import { createRng } from "@/lib/sudoku/rng";
import { countSolutions, countSolutionsWithin } from "@/lib/sudoku/solver";
import { scoreMoves } from "./score";
import {
  activeMistakeLimit,
  elapsedOf,
  formatTime,
  isGiven,
  isInProgress,
  isShownWrong,
  isSolved,
  isWrong,
  MISTAKE_LIMITS,
  newGame,
  parseMistakeLimit,
  persisted,
  reduce,
  restartGame,
  REWIND_MAX_NODES,
  selectedCells,
  stuckCells,
  withSolution,
  type Action,
  type GameState,
  type MistakeLimit,
  type Mode,
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

  it("矢印キーで動かす起点は選んでいるマス。選んでいなければフォーカスしているマス（from）、それも無ければ中央", () => {
    const { s: s0 } = freeGame();
    expect(run(s0, { type: "move", dr: 0, dc: 1 }).s.selected).toBe(41);
    expect(run(s0, { type: "move", dr: 0, dc: 1, from: 10 }).s.selected).toBe(11);
    // 端では反対側へ回り込む
    expect(run(s0, { type: "move", dr: -1, dc: 0, from: 3 }).s.selected).toBe(75);
    const picked = run(s0, { type: "select", cell: 20 }).s;
    expect(run(picked, { type: "move", dr: 1, dc: 0, from: 10 }).s.selected).toBe(29);
  });

  it("間違いとして見せるのは、重複はいつも、解答と違うだけなら「間違いをすぐ表示」のときだけ", () => {
    for (const showMistakes of [true, false]) {
      expect(isShownWrong({ conflict: true, wrong: true }, showMistakes)).toBe(true);
      expect(isShownWrong({ conflict: true, wrong: false }, showMistakes)).toBe(true);
      expect(isShownWrong({ conflict: false, wrong: false }, showMistakes)).toBe(false);
    }
    expect(isShownWrong({ conflict: false, wrong: true }, true)).toBe(true);
    expect(isShownWrong({ conflict: false, wrong: true }, false)).toBe(false);
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

  it("解けるか確かめ終わらない盤面まで戻したら、そこで止め、それより前の手は消さない", () => {
    // 解が無いことを確かめるのに何百万回も置く盤面（1 行目に 1 を置けない。重複は無い）
    const HEAVY = parseGrid(
      "000000002010000000000010000690500100070000000000001030035020010700000000100000670",
    );
    const { s } = run(
      newGame({ mode: "free", difficulty: "master", seed: "x", puzzle: HEAVY, solution: null }),
      // 1 手目は重複の無い数字、2 手目は同じ行の 1 手目と重なる
      { type: "select", cell: 73 },
      { type: "input", digit: 2 },
      { type: "select", cell: 74 },
      { type: "input", digit: 2 },
    );
    expect(
      countSolutionsWithin(
        s.values.map((v, i) => (i === 74 ? 0 : v)),
        1,
        REWIND_MAX_NODES,
      ),
    ).toBeNull();
    const t = performance.now();
    const [back, effects] = reduce(s, { type: "rewind" });
    expect(performance.now() - t).toBeLessThan(2000);
    expect(effects[0]).toEqual({ kind: "rewind", steps: 1 });
    expect(back.history).toHaveLength(1);
    expect(back.values[73]).toBe(2);
    expect(back.values[74]).toBe(0);
    // 止めた盤面でもう一度押しても、確かめ終わらないので何もしない
    expect(reduce(back, { type: "rewind" })[1][0].kind).toBe("blocked");
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
      [{ type: "extendSelection", cell: peer }],
      [{ type: "toggleSelection", cell: peer }],
      [{ type: "move", dr: 1, dc: 0 }],
      [{ type: "toggleNotes" }],
      [{ type: "toggleColors" }],
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
      [
        { type: "toggleSelection", cell: peer },
        { type: "input", digit: 1 },
      ],
      [{ type: "toggleColors" }, { type: "input", digit: 2 }],
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

describe("複数選択とメモの一括入力", () => {
  /**
   * 空きマス a・b・c と、正解を置いた空きマス d、ヒントのマス given を選ぶ（a が基準）。
   * a と、選ばない空きマス e にはメモ 4 を付けておく
   */
  function picked(s0: GameState, solution: number[]) {
    const [a, b, c, d, e] = s0.puzzle.flatMap((v, i) => (v ? [] : [i]));
    const given = s0.puzzle.findIndex((v) => v !== 0);
    const { s } = run(
      s0,
      { type: "select", cell: d },
      { type: "input", digit: solution[d], t: 1000 },
      { type: "select", cell: e },
      { type: "input", digit: 4, asNote: true },
      { type: "select", cell: a },
      { type: "input", digit: 4, asNote: true },
      { type: "extendSelection", cell: b },
      { type: "extendSelection", cell: c },
      { type: "toggleSelection", cell: d },
      { type: "toggleSelection", cell: given },
    );
    return { s, a, b, c, d, e, given };
  }
  const notesOf = (s: GameState, cells: number[]) => cells.map((i) => s.notes[i]);

  it("なぞる・修飾キーで選択に足し、選択・移動・Esc で 1 マスに戻る", () => {
    const { s: s0 } = freeGame();
    let s = run(
      s0,
      { type: "select", cell: 0 },
      { type: "extendSelection", cell: 1 },
      { type: "extendSelection", cell: 2 },
    ).s;
    expect([s.selected, s.selection]).toEqual([0, [1, 2]]);
    // 選んであるマスをなぞっても変わらない
    expect(run(s, { type: "extendSelection", cell: 1 }).s).toBe(s);
    expect(run(s, { type: "extendSelection", cell: 0 }).s).toBe(s);
    // 修飾キーは、選んでいなければ足し、選んでいれば外す
    s = run(s, { type: "toggleSelection", cell: 10 }, { type: "toggleSelection", cell: 1 }).s;
    expect(selectedCells(s)).toEqual([0, 2, 10]);
    // 基準のマスを外すと、最後に足したマスが基準になる
    s = run(s, { type: "toggleSelection", cell: 0 }).s;
    expect([s.selected, s.selection]).toEqual([10, [2]]);
    s = run(s, { type: "toggleSelection", cell: 2 }).s;
    expect([s.selected, s.selection]).toEqual([10, undefined]);
    expect(run(s, { type: "toggleSelection", cell: 10 }).s.selected).toBe(null);
    // 何も選んでいなければ、そのマスを選ぶ
    expect(selectedCells(run(s0, { type: "toggleSelection", cell: 5 }).s)).toEqual([5]);
    expect(selectedCells(run(s0, { type: "extendSelection", cell: 5 }).s)).toEqual([5]);

    const many = run(s0, { type: "select", cell: 0 }, { type: "extendSelection", cell: 1 }).s;
    expect(run(many, { type: "select", cell: 1 }).s).toMatchObject({ selected: 1, selection: undefined });
    expect(run(many, { type: "move", dr: 1, dc: 0 }).s).toMatchObject({ selected: 9, selection: undefined });
    // Esc は選択を外す
    expect(run(many, { type: "select", cell: null }).s).toMatchObject({
      selected: null,
      selection: undefined,
    });
  });

  it.each([
    ["オフ", false],
    ["オン", true],
  ] as const)(
    "数字は、選んだ空きマスすべてにあれば消し、どこかに無ければ全部に足す（メモモード%s）",
    (_, notesMode) => {
      const { p, s: s0 } = freeGame();
      const { s: base, a, b, c, d, e, given } = picked(s0, p.solution);
      const s = notesMode ? run(base, { type: "toggleNotes" }).s : base;
      expect(notesOf(s, [a, b, c, e])).toEqual([1 << 4, 0, 0, 1 << 4]);

      const added = run(s, { type: "input", digit: 4 });
      expect(added.effects).toEqual([{ kind: "note", cell: -1, digit: 4, on: true }]);
      expect(notesOf(added.s, [a, b, c, e])).toEqual([1 << 4, 1 << 4, 1 << 4, 1 << 4]);
      // 数字のあるマスとヒントのマスは飛ばし、数字も置かない
      expect(added.s.values).toEqual(s.values);
      expect(notesOf(added.s, [d, given])).toEqual([0, 0]);
      expect(added.s.history).toHaveLength(s.history.length + 1);
      expect(added.s.history.at(-1)!.bulkNotes).toEqual(s.notes);

      const removed = run(added.s, { type: "input", digit: 4 });
      expect(removed.effects).toEqual([{ kind: "note", cell: -1, digit: 4, on: false }]);
      // 選んでいないマスのメモは残る
      expect(notesOf(removed.s, [a, b, c, e])).toEqual([0, 0, 0, 1 << 4]);
      // Shift+数字（asNote）でも同じ
      expect(run(removed.s, { type: "input", digit: 4, asNote: true }).s.notes).toEqual(added.s.notes);
      // 選択は動かない
      expect(selectedCells(removed.s)).toEqual(selectedCells(s));
    },
  );

  it("選んだマスに空きが無ければ何もしない", () => {
    const { p, s: s0 } = freeGame();
    const { s: base, d, given } = picked(s0, p.solution);
    const s = run(base, { type: "select", cell: d }, { type: "toggleSelection", cell: given }).s;
    for (const a of [{ type: "input", digit: 5 }, { type: "erase" }] as Action[]) {
      const out = run(s, a);
      expect(out.s).toBe(s);
      expect(out.effects).toEqual([{ kind: "blocked" }]);
    }
  });

  it("消すは選んだ空きマスのメモだけを消し、数字は消さない。戻す・進むで選択は動かない", () => {
    const { p, s: s0 } = freeGame();
    const { s: base, a, b, c, d, e } = picked(s0, p.solution);
    const s = run(base, { type: "input", digit: 6 }).s;
    expect(notesOf(s, [a, b, c])).toEqual([(1 << 4) | (1 << 6), 1 << 6, 1 << 6]);
    const erased = run(s, { type: "erase" });
    expect(erased.effects).toEqual([{ kind: "erase", cell: -1 }]);
    expect(notesOf(erased.s, [a, b, c, e])).toEqual([0, 0, 0, 1 << 4]);
    expect(erased.s.values).toEqual(s.values);
    expect(erased.s.values[d]).toBe(p.solution[d]);
    // 消すメモが無ければ何もしない
    expect(run(erased.s, { type: "erase" }).effects).toEqual([{ kind: "blocked" }]);

    const undone = run(erased.s, { type: "undo" });
    expect(undone.effects).toEqual([{ kind: "undo", cell: -1 }]);
    expect(undone.s.notes).toEqual(s.notes);
    expect([undone.s.selected, undone.s.selection]).toEqual([s.selected, s.selection]);
    const redone = run(undone.s, { type: "redo" });
    expect(redone.effects).toEqual([{ kind: "redo", cell: -1 }]);
    expect(redone.s.notes).toEqual(erased.s.notes);
    expect([redone.s.selected, redone.s.selection]).toEqual([s.selected, s.selection]);
    // 2 つ戻すと、まとめて付けたメモ 6 の前に戻る
    expect(run(redone.s, { type: "undo" }, { type: "undo" }).s.notes).toEqual(base.notes);
  });

  it("1 マスの手を戻す・進む、ヒントで置くと、選択はそのマスだけになる", () => {
    const { p, s: s0 } = freeGame();
    const { s, a, d } = picked(s0, p.solution);
    // 最後の 1 マスの手は a のメモ 4
    const undone = run(s, { type: "undo" }).s;
    expect([undone.selected, undone.selection]).toEqual([a, undefined]);
    const again = run(undone, { type: "extendSelection", cell: d }, { type: "redo" }).s;
    expect([again.selected, again.selection]).toEqual([a, undefined]);
    const hinted = run(s, { type: "hint", cell: s.puzzle.lastIndexOf(0) }).s;
    expect([hinted.selected, hinted.selection]).toEqual([s.puzzle.lastIndexOf(0), undefined]);
  });

  it("一時停止中は選択もメモも変えない", () => {
    const { p, s: s0 } = freeGame();
    const { s, b } = picked(s0, p.solution);
    const paused = run(s, { type: "pause" }).s;
    for (const a of [
      { type: "input", digit: 7 },
      { type: "erase" },
      { type: "extendSelection", cell: b + 9 },
      { type: "toggleSelection", cell: b },
    ] as Action[]) {
      expect(reduce(paused, a)).toEqual([paused, []]);
    }
  });

  it("日次でも使え、手の記録・点数・ミスは変わらない", () => {
    const p = generatePuzzle("daily-multi", "easy");
    const s0 = withSolution(
      newGame({
        mode: "daily",
        difficulty: "easy",
        seed: "2026-10-17",
        puzzle: p.puzzle,
        solution: null,
        daily: { sessionId: "s", date: "2026-10-17", startedAt: 0, clockOffset: 0 },
      }),
    );
    const { s, a, b, d } = picked(s0, p.solution);
    expect(s.moves).toEqual([[1000, d, p.solution[d]]]);
    const after = run(
      s,
      { type: "input", digit: 2 },
      { type: "input", digit: 3 },
      { type: "erase" },
      { type: "input", digit: 5 },
    );
    expect(notesOf(after.s, [a, b])).toEqual([1 << 5, 1 << 5]);
    expect(after.s.history).toHaveLength(s.history.length + 4);
    expect(after.s.moves).toEqual(s.moves);
    expect(after.s.score).toEqual(s.score);
    expect(after.s.mistakes).toBe(s.mistakes);
  });

  it("保存するときは選択を落とす", () => {
    const { p, s: s0 } = freeGame();
    const { s } = picked(s0, p.solution);
    expect(s.selection?.length).toBeGreaterThan(0);
    const saved = JSON.parse(JSON.stringify(persisted(run(s, { type: "input", digit: 8 }).s)));
    expect(saved).not.toHaveProperty("selection");
    expect(saved).not.toHaveProperty("future");
    expect(saved.selected).toBe(null);
  });
});

describe("マスの色", () => {
  /**
   * 空きマス a・b、正解を置いたマス d、最初から入っているマス given。a にはメモ 4 を付けておき、色モードで a を選んだ状態で返す
   */
  function colored(s0: GameState, solution: number[]) {
    const [a, b, d] = s0.puzzle.flatMap((v, i) => (v ? [] : [i]));
    const given = s0.puzzle.findIndex((v) => v !== 0);
    const { s } = run(
      s0,
      { type: "select", cell: d },
      { type: "input", digit: solution[d], t: 1000 },
      { type: "select", cell: a },
      { type: "input", digit: 4, asNote: true },
      { type: "toggleColors" },
    );
    return { s, a, b, d, given };
  }
  const colorsAt = (s: GameState, cells: number[]) => cells.map((i) => s.colors![i]);

  it("色モードでは数字で選んだマスに色を付け、同じ色をもう一度で外す。数字とメモは変えない", () => {
    const { p, s: s0 } = freeGame();
    const { s, a, d, given } = colored(s0, p.solution);
    expect(s.colorMode).toBe(true);
    for (const cell of [a, d, given]) {
      const base = run(s, { type: "select", cell }).s;
      const on = run(base, { type: "input", digit: 3 });
      expect(on.effects).toEqual([{ kind: "color", color: 3, on: true }]);
      expect(on.s.colors![cell]).toBe(3);
      expect(on.s.colors!.filter((c) => c)).toHaveLength(1);
      expect(on.s.values).toEqual(s.values);
      expect(on.s.notes).toEqual(s.notes);
      expect(on.s.history).toHaveLength(s.history.length + 1);
      expect(on.s.history.at(-1)).toMatchObject({ cell: -1, bulkColors: s.colors });
      // 別の色に塗り替え、同じ色でもう一度で外す
      const other = run(on.s, { type: "input", digit: 7 }).s;
      expect(other.colors![cell]).toBe(7);
      const off = run(other, { type: "input", digit: 7 });
      expect(off.effects).toEqual([{ kind: "color", color: 7, on: false }]);
      expect(off.s.colors![cell]).toBe(0);
    }
  });

  it("複数選択では、すべてがその色なら全部から外し、どこかが違えば全部をその色にする", () => {
    const { p, s: s0 } = freeGame();
    const { s: base, a, b, d, given } = colored(s0, p.solution);
    const cells = [a, b, d, given];
    // a だけ先に 5、b は 2 にしておく
    const pre = run(
      base,
      { type: "input", digit: 5 },
      { type: "select", cell: b },
      { type: "input", digit: 2 },
    ).s;
    const s = run(
      pre,
      { type: "select", cell: a },
      { type: "toggleSelection", cell: b },
      { type: "toggleSelection", cell: d },
      { type: "toggleSelection", cell: given },
    ).s;
    expect(colorsAt(s, cells)).toEqual([5, 2, 0, 0]);
    const all = run(s, { type: "input", digit: 5 });
    expect(all.effects).toEqual([{ kind: "color", color: 5, on: true }]);
    expect(colorsAt(all.s, cells)).toEqual([5, 5, 5, 5]);
    // 1 手として積み、メモは付けない
    expect(all.s.history).toHaveLength(s.history.length + 1);
    expect(all.s.notes).toEqual(s.notes);
    const none = run(all.s, { type: "input", digit: 5 });
    expect(none.effects).toEqual([{ kind: "color", color: 5, on: false }]);
    expect(colorsAt(none.s, cells)).toEqual([0, 0, 0, 0]);
    // Shift+数字（asNote）でも色になる
    expect(run(s, { type: "input", digit: 5, asNote: true }).s.colors).toEqual(all.s.colors);
    // 選択は動かない
    expect(selectedCells(none.s)).toEqual(selectedCells(s));
  });

  it("消すは選んだマスの色だけを外し、数字とメモは残す。色が無ければ何もしない", () => {
    const { p, s: s0 } = freeGame();
    const { s: base, a, b, d } = colored(s0, p.solution);
    const s = run(
      base,
      { type: "toggleSelection", cell: b },
      { type: "toggleSelection", cell: d },
      { type: "input", digit: 6 },
      { type: "toggleSelection", cell: b },
    ).s;
    expect(selectedCells(s)).toEqual([a, d]);
    const erased = run(s, { type: "erase" });
    expect(erased.effects).toEqual([{ kind: "erase", cell: -1 }]);
    expect(colorsAt(erased.s, [a, b, d])).toEqual([0, 6, 0]);
    expect(erased.s.values).toEqual(s.values);
    expect(erased.s.notes).toEqual(s.notes);
    expect(erased.s.notes[a]).toBe(1 << 4);
    expect(run(erased.s, { type: "erase" }).effects).toEqual([{ kind: "blocked" }]);
    // 1 マスでも同じ
    const one = run(s, { type: "select", cell: d }, { type: "erase" }).s;
    expect(one.values[d]).toBe(p.solution[d]);
    expect(one.colors![d]).toBe(0);
    // colors: false なら色モードでも数字を消す（手筋ヒントの「消す」）
    const value = run(s, { type: "select", cell: d }, { type: "erase", colors: false }).s;
    expect(value.values[d]).toBe(0);
    expect(value.colors![d]).toBe(6);
  });

  it("選んだマスが無ければ塗らない", () => {
    const { s: s0 } = freeGame();
    const s = run(s0, { type: "toggleColors" }).s;
    for (const a of [{ type: "input", digit: 1 }, { type: "erase" }] as Action[]) {
      const out = run(s, a);
      expect(out.s).toBe(s);
      expect(out.effects).toEqual([{ kind: "blocked" }]);
    }
  });

  it("メモモードとは同時にオンにならない", () => {
    const { s: s0 } = freeGame();
    const notes = run(s0, { type: "toggleNotes" }).s;
    expect([notes.notesMode, notes.colorMode]).toEqual([true, false]);
    const colors = run(notes, { type: "toggleColors" }).s;
    expect([colors.notesMode, colors.colorMode]).toEqual([false, true]);
    const back = run(colors, { type: "toggleNotes" }).s;
    expect([back.notesMode, back.colorMode]).toEqual([true, false]);
    expect(run(colors, { type: "toggleColors" }).s).toMatchObject({ notesMode: false, colorMode: false });
    // 色モードを外すと、数字はまた値として入る
    const cell = s0.puzzle.indexOf(0);
    const placed = run(
      colors,
      { type: "toggleColors" },
      { type: "select", cell },
      { type: "input", digit: 1 },
    ).s;
    expect(placed.values[cell]).toBe(1);
    expect(placed.colors![cell]).toBe(0);
  });

  it("戻す・進むで色が元どおりになり、選択は動かない。新しい手を打つと進めなくなる", () => {
    const { p, s: s0 } = freeGame();
    const { s: base, a, b } = colored(s0, p.solution);
    const steps: Action[][] = [
      [{ type: "input", digit: 1 }],
      [
        { type: "toggleSelection", cell: b },
        { type: "input", digit: 2 },
      ],
      [
        { type: "toggleColors" },
        { type: "select", cell: b },
        { type: "input", digit: p.solution[b], t: 2000 },
      ],
      [
        { type: "toggleColors" },
        { type: "select", cell: a },
        { type: "toggleSelection", cell: b },
        { type: "input", digit: 3 },
      ],
      [{ type: "erase" }],
      [{ type: "autoNotes" }],
    ];
    const states = [base];
    for (const actions of steps) states.push(run(states[states.length - 1], ...actions).s);
    let s = states[steps.length];
    expect(s.history).toHaveLength(base.history.length + steps.length);
    for (let k = steps.length - 1; k >= 0; k--) {
      const prev = s;
      const { s: next, effects } = run(s, { type: "undo" });
      expect(next.values).toEqual(states[k].values);
      expect(next.notes).toEqual(states[k].notes);
      expect(next.colors).toEqual(states[k].colors);
      if (prev.history.at(-1)!.bulkColors) {
        expect(effects).toEqual([{ kind: "undo", cell: -1 }]);
        expect(selectedCells(next)).toEqual(selectedCells(prev));
      }
      s = next;
    }
    for (let k = 1; k <= steps.length; k++) {
      const prev = s;
      const { s: next, effects } = run(s, { type: "redo" });
      expect(next.values).toEqual(states[k].values);
      expect(next.notes).toEqual(states[k].notes);
      expect(next.colors).toEqual(states[k].colors);
      expect(next.history).toEqual(states[k].history);
      if (next.history.at(-1)!.bulkColors) {
        expect(effects).toEqual([{ kind: "redo", cell: -1 }]);
        expect(selectedCells(next)).toEqual(selectedCells(prev));
      }
      s = next;
    }
    expect(s.future).toEqual([]);
    // 戻したあとに色を変えると進めなくなる
    expect(run(s, { type: "undo" }, { type: "input", digit: 9 }, { type: "redo" }).effects[0].kind).toBe(
      "blocked",
    );
  });

  it("古い保存データ（色なし）でも塗れ、戻すと色なしに戻る", () => {
    const { s: s0 } = freeGame();
    const { colors: _, colorMode: __, ...old } = s0;
    const cell = s0.puzzle.indexOf(0);
    const painted = run(
      old as GameState,
      { type: "toggleColors" },
      { type: "select", cell },
      { type: "input", digit: 4 },
    ).s;
    expect(painted.colors![cell]).toBe(4);
    const undone = run(painted, { type: "undo" }).s;
    expect(undone.colors).toEqual(Array(81).fill(0));
    expect(run(undone, { type: "redo" }).s.colors).toEqual(painted.colors);
  });

  it("日次でも使え、手の記録・点数・ミスは変わらない", () => {
    const p = generatePuzzle("daily-colors", "easy");
    const s0 = withSolution(
      newGame({
        mode: "daily",
        difficulty: "easy",
        seed: "2026-10-17",
        puzzle: p.puzzle,
        solution: null,
        daily: { sessionId: "s", date: "2026-10-17", startedAt: 0, clockOffset: 0 },
      }),
    );
    const { s, a, b, d, given } = colored(s0, p.solution);
    expect(s.moves).toEqual([[1000, d, p.solution[d]]]);
    const after = run(
      s,
      { type: "input", digit: 2 },
      { type: "toggleSelection", cell: b },
      { type: "toggleSelection", cell: given },
      { type: "input", digit: 3 },
      { type: "erase" },
      { type: "input", digit: 8 },
      { type: "undo" },
      { type: "redo" },
    );
    expect(colorsAt(after.s, [a, b, given])).toEqual([8, 8, 8]);
    expect(after.s.moves).toEqual(s.moves);
    expect(after.s.score).toEqual(s.score);
    expect(after.s.mistakes).toBe(s.mistakes);
  });

  it("間違えた数字や重複のあるマスに色を付けても、間違い・重複のままで、ミスの数は変わらない", () => {
    const { p, s: s0 } = freeGame();
    const [a, b] = s0.puzzle.flatMap((v, i) => (v ? [] : [i]));
    // a には解答と違う数字、b には同じ行・列・ブロックにある数字を置く
    const dupe = s0.puzzle[PEERS[b].find((i) => s0.puzzle[i] !== 0)!];
    const s = run(
      s0,
      { type: "select", cell: a },
      { type: "input", digit: (p.solution[a] % 9) + 1 },
      { type: "select", cell: b },
      { type: "input", digit: dupe },
    ).s;
    expect(isWrong(s, a)).toBe(true);
    expect(findConflicts(s.values).has(b)).toBe(true);
    const painted = run(
      s,
      { type: "toggleColors" },
      { type: "select", cell: a },
      { type: "toggleSelection", cell: b },
      { type: "input", digit: 6 },
    ).s;
    expect(colorsAt(painted, [a, b])).toEqual([6, 6]);
    expect(painted.values).toEqual(s.values);
    expect(isWrong(painted, a)).toBe(true);
    expect(findConflicts(painted.values).has(b)).toBe(true);
    expect(painted.mistakes).toBe(s.mistakes);
  });

  it("一時停止中と解き終えた後は、色も色モードも変えない", () => {
    const { p, s: s0 } = freeGame();
    const { s } = colored(s0, p.solution);
    const paused = run(s, { type: "pause" }).s;
    let solved = run(
      s0,
      { type: "toggleColors" },
      { type: "select", cell: 0 },
      { type: "input", digit: 1 },
      { type: "toggleColors" },
    ).s;
    for (let i = 0; i < 81; i++) {
      if (p.puzzle[i]) continue;
      solved = run(solved, { type: "select", cell: i }, { type: "input", digit: p.solution[i] }).s;
    }
    expect(solved.status).toBe("solved");
    // 解き終えても色は残る
    expect(solved.colors![0]).toBe(1);
    const solvedColorMode = { ...solved, colorMode: true, selected: 0 };
    for (const g of [paused, solvedColorMode]) {
      for (const a of [
        { type: "input", digit: 2 },
        { type: "erase" },
        { type: "toggleColors" },
        { type: "toggleNotes" },
      ] as Action[]) {
        expect(reduce(g, a)).toEqual([g, []]);
      }
    }
  });
});

describe("練習", () => {
  function games(seed: string) {
    const p = generatePuzzle(seed, "easy");
    const base = { difficulty: "easy" as const, puzzle: p.puzzle, solution: p.solution };
    return {
      p,
      free: newGame({ ...base, mode: "free", seed }),
      daily: newGame({
        ...base,
        mode: "daily",
        seed: "2026-10-17",
        daily: { sessionId: "s", date: "2026-10-17", startedAt: 0, clockOffset: 0 },
      }),
      practice: newGame({ ...base, mode: "practice", seed }),
    };
  }

  it("ヒント・自動メモ・ヒントのメモ反映を塞ぐのは日次だけで、練習では使える", () => {
    const { p, free, daily, practice } = games("practice-assist");
    const cell = p.puzzle.indexOf(0);
    const actions: Action[] = [
      { type: "hint", cell },
      { type: "hint" },
      { type: "hintUsed" },
      { type: "autoNotes" },
      { type: "setNotes", notes: Array(81).fill(1 << 2) },
    ];
    for (const a of actions) {
      expect(
        run(daily, a).effects.map((e) => e.kind),
        a.type,
      ).toEqual(["blocked"]);
      // 練習はフリープレイと同じ結果になる
      const [f, pr] = [run(free, a), run(practice, a)];
      expect(pr.effects, a.type).toEqual(f.effects);
      expect(pr.effects.map((e) => e.kind)).not.toContain("blocked");
      expect({ ...pr.s, mode: "free" }).toEqual(f.s);
    }
    expect(run(practice, { type: "hint", cell }).s.values[cell]).toBe(p.solution[cell]);
  });

  it("時計は進まず、一時停止もしない", () => {
    const { practice } = games("practice-clock");
    const ticked = run(practice, { type: "tick", ms: 5000 }, { type: "tick", ms: 5000 }).s;
    expect(ticked).toBe(practice);
    expect(elapsedOf(ticked, 1e12)).toBe(0);
    const paused = run(practice, { type: "pause" }).s;
    expect(paused).toBe(practice);
    expect(paused.status).toBe("playing");
  });

  it("置いた手は記録しない（サーバーに送る手の記録は日次だけ）", () => {
    const { p, daily, practice } = games("practice-moves");
    const cell = p.puzzle.indexOf(0);
    const actions: Action[] = [
      { type: "select", cell },
      { type: "input", digit: p.solution[cell], t: 1000 },
    ];
    expect(run(daily, ...actions).s.moves).toEqual([[1000, cell, p.solution[cell]]]);
    const placed = run(practice, ...actions).s;
    expect(placed.values[cell]).toBe(p.solution[cell]);
    expect(placed.moves).toEqual([]);
  });

  it("全マスを埋めても解き終えにならない（フリープレイは解き終える）", () => {
    const { p, free, practice } = games("practice-solve");
    const fillAll = (s: GameState) =>
      run(
        s,
        ...p.puzzle.flatMap((v, cell): Action[] =>
          v
            ? []
            : [
                { type: "select", cell },
                { type: "input", digit: p.solution[cell] },
              ],
        ),
      );
    const f = fillAll(free);
    expect(f.s.status).toBe("solved");
    expect(f.effects.map((e) => e.kind)).toContain("solved");
    const pr = fillAll(practice);
    expect(pr.s.values).toEqual(p.solution);
    expect(pr.s.status).toBe("playing");
    expect(pr.effects.map((e) => e.kind)).not.toContain("solved");
  });

  it("始めのメモを渡せる（写しを持ち、元に戻す手には入らない）", () => {
    const p = generatePuzzle("practice-notes", "easy");
    const notes = Array.from({ length: 81 }, (_, i) => (p.puzzle[i] ? 0 : 1 << p.solution[i]));
    const g = newGame({
      mode: "practice",
      difficulty: "easy",
      seed: "x",
      puzzle: p.puzzle,
      solution: p.solution,
      notes,
    });
    expect(g.notes).toEqual(notes);
    expect(g.notes).not.toBe(notes);
    expect(g.history).toEqual([]);
  });
});

describe("最初の誤り", () => {
  const empties = (s: GameState) => s.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const wrongOf = (answer: number) => (answer % 9) + 1;
  const put = (cell: number, digit: number): Action[] => [
    { type: "select", cell },
    { type: "input", digit },
  ];

  /**
   * 盤面の数字だけから、cell に answer を 1 手で置けるシングル（ネイキッドを先に見る）。
   * 記録の側（findAllSteps）とは別に、候補を数えて確かめる
   */
  function singleOf(values: number[], cell: number, answer: number) {
    const grid = values.slice();
    grid[cell] = 0;
    if (bitCount(candidatesAt(grid, cell)) === 1) return "naked-single";
    const bit = 1 << answer;
    const hidden = UNITS_OF[cell].some((u) =>
      UNITS[u].every((i) => i === cell || grid[i] !== 0 || !(candidatesAt(grid, i) & bit)),
    );
    return hidden ? "hidden-single" : null;
  }

  it("最初の誤りだけを記録する。何手目は数字を置いた回数（ヒントを含む。メモ・消す・色・戻す・進むは数えない）", () => {
    const { p, s: s0 } = freeGame();
    const [a, b, c, d] = empties(s0);
    expect(s0.placed).toBe(0);
    expect(s0.firstMistake).toBeUndefined();
    const before = run(
      s0,
      { type: "select", cell: a },
      { type: "input", digit: 3, asNote: true },
      { type: "input", digit: p.solution[a] },
      { type: "erase" },
      { type: "toggleColors" },
      { type: "input", digit: 2 },
      { type: "toggleColors" },
      { type: "hintUsed" },
      { type: "hint", cell: b },
      { type: "undo" },
      { type: "redo" },
    ).s;
    // a に置いた 1 回と、ヒントで b に置いた 1 回
    expect(before.placed).toBe(2);
    expect(before.firstMistake).toBeUndefined();
    const first = run(before, ...put(c, wrongOf(p.solution[c]))).s;
    expect(first.mistakes).toBe(1);
    expect(first.placed).toBe(3);
    expect(first.firstMistake).toEqual({
      move: 3,
      cell: c,
      digit: wrongOf(p.solution[c]),
      answer: p.solution[c],
      technique: singleOf(before.values, c, p.solution[c]),
    });
    // 2 つ目の誤りでは変えない
    const second = run(first, ...put(d, wrongOf(p.solution[d]))).s;
    expect(second.mistakes).toBe(2);
    expect(second.placed).toBe(4);
    expect(second.firstMistake).toEqual(first.firstMistake);
  });

  it("戻す・間違える前まで戻すで盤面から消しても残し、進むでも変えない（ミスの数と同じく、置いた事実として数える）", () => {
    const { p, s: s0 } = freeGame();
    const [a, b] = empties(s0);
    const wrong = run(s0, ...put(a, wrongOf(p.solution[a]))).s;
    const recorded = wrong.firstMistake;
    expect(recorded).toMatchObject({ move: 1, cell: a });
    const undone = run(wrong, { type: "undo" }).s;
    expect(undone.values[a]).toBe(0);
    expect(undone.firstMistake).toEqual(recorded);
    expect(undone.placed).toBe(1);
    expect(run(undone, { type: "redo" }).s.firstMistake).toEqual(recorded);
    // 戻した後に入れた誤りは最初ではない
    expect(run(undone, ...put(b, wrongOf(p.solution[b]))).s.firstMistake).toEqual(recorded);
    // 解答と違う数字があると解けないので、間違える前まで戻すで消える
    const { s: back, effects } = run(wrong, { type: "rewind" });
    expect(effects[0]).toEqual({ kind: "rewind", steps: 1 });
    expect(back.values[a]).toBe(0);
    expect(back.firstMistake).toEqual(recorded);
    expect(back.placed).toBe(1);
  });

  it("重複しない誤り（間違いの表示がオフなら気づけないもの）も記録する。日次も端末で解いた解答と照合して記録する", () => {
    const p = generatePuzzle("first-mistake-daily", "hard");
    const daily = withSolution(
      newGame({
        mode: "daily",
        difficulty: "hard",
        seed: "2026-10-24",
        puzzle: p.puzzle,
        solution: null,
        daily: { sessionId: "s", date: "2026-10-24", startedAt: 0, clockOffset: 0 },
      }),
    );
    const free = newGame({
      mode: "free",
      difficulty: "hard",
      seed: "x",
      puzzle: p.puzzle,
      solution: p.solution,
    });
    const cell = p.puzzle.findIndex((v, i) => !v && bitCount(candidatesAt(p.puzzle, i)) >= 2);
    const digit = digitsOf(candidatesAt(p.puzzle, cell)).find((d) => d !== p.solution[cell])!;
    for (const s0 of [daily, free]) {
      const { s, effects } = run(s0, ...put(cell, digit));
      expect(effects[0]).toMatchObject({ kind: "place", wrong: true, conflict: false });
      expect(s.firstMistake).toEqual({
        move: 1,
        cell,
        digit,
        answer: p.solution[cell],
        technique: singleOf(p.puzzle, cell, p.solution[cell]),
      });
    }
  });

  it("手筋は、置く直前の盤面の数字だけから、そのマスに正解を 1 手で置けたシングル。無ければ null", () => {
    const p = generatePuzzle("first-mistake-technique", "hard");
    const s0 = newGame({
      mode: "free",
      difficulty: "hard",
      seed: "x",
      puzzle: p.puzzle,
      solution: p.solution,
    });
    // 空きマスのうち 3 つに 1 つを正しく埋めた途中の盤面
    const base = run(
      s0,
      ...empties(s0)
        .filter((_, k) => k % 3 === 0)
        .flatMap((i) => put(i, p.solution[i])),
    ).s;
    // メモは見ない（正解を消したメモがあっても、盤面の数字だけで調べる）
    const noted = run(base, { type: "setNotes", notes: Array(81).fill(1 << 1) }).s;
    const seen = new Set<string | null>();
    for (const cell of empties(base).filter((i) => !base.values[i])) {
      const answer = p.solution[cell];
      const expected = singleOf(base.values, cell, answer);
      seen.add(expected);
      for (const g of [base, noted]) {
        expect(run(g, ...put(cell, wrongOf(answer))).s.firstMistake?.technique, `${cell}`).toBe(expected);
      }
    }
    // ネイキッド・ヒドゥン・どちらも無いマスがそろっている盤面で確かめる
    expect(seen).toEqual(new Set(["naked-single", "hidden-single", null]));
  });

  it("正しい数字を誤りで上書きしても記録し、手筋はそのマスを空けた盤面で調べる", () => {
    const { p, s: s0 } = freeGame();
    const cell = empties(s0)[0];
    const placed = run(s0, ...put(cell, p.solution[cell])).s;
    const { s } = run(placed, { type: "input", digit: wrongOf(p.solution[cell]) });
    expect(s.firstMistake).toEqual({
      move: 2,
      cell,
      digit: wrongOf(p.solution[cell]),
      answer: p.solution[cell],
      technique: singleOf(s0.values, cell, p.solution[cell]),
    });
  });

  it("ミスが無ければ記録しない。練習は結果を出さないので記録しない", () => {
    const { p, s: s0 } = freeGame();
    const solved = run(s0, ...empties(s0).flatMap((i) => put(i, p.solution[i]))).s;
    expect(solved.status).toBe("solved");
    expect(solved.mistakes).toBe(0);
    expect(solved.placed).toBe(empties(s0).length);
    expect(solved.firstMistake).toBeUndefined();

    const practice = newGame({
      mode: "practice",
      difficulty: "easy",
      seed: "x",
      puzzle: p.puzzle,
      solution: p.solution,
    });
    const cell = empties(practice)[0];
    const wrong = run(practice, ...put(cell, wrongOf(p.solution[cell]))).s;
    expect(wrong.mistakes).toBe(1);
    expect(wrong.firstMistake).toBeUndefined();
  });

  it("保存して開き直しても残り、続きから数える", () => {
    const { p, s: s0 } = freeGame();
    const [a, b] = empties(s0);
    const s = run(s0, ...put(a, p.solution[a]), ...put(b, wrongOf(p.solution[b]))).s;
    const reopened = withSolution(JSON.parse(JSON.stringify(persisted(s))) as GameState);
    expect(reopened.firstMistake).toEqual(s.firstMistake);
    expect(reopened.placed).toBe(2);
    expect(run(reopened, ...put(b, p.solution[b])).s.placed).toBe(3);
  });

  it("古い保存データ（置いた回数なし）では、何手目か分からないので記録しない。壊れずに遊べる", () => {
    const { p, s: s0 } = freeGame();
    const { placed: _, ...old } = s0;
    const [a, b] = empties(s0);
    const s = run(old as GameState, ...put(a, wrongOf(p.solution[a])), ...put(b, p.solution[b])).s;
    expect(s.mistakes).toBe(1);
    expect(s.values[b]).toBe(p.solution[b]);
    expect(s.placed).toBeUndefined();
    expect(s.firstMistake).toBeUndefined();
    expect(JSON.parse(JSON.stringify(persisted(s)))).not.toHaveProperty("firstMistake");
  });

  it("置いた回数が整数でない保存データ（書き換えたもの）では、数えず記録しない", () => {
    const { p, s: s0 } = freeGame();
    const [a, b] = empties(s0);
    for (const placed of ["3", 1.5, null, Number.NaN]) {
      const broken = { ...s0, placed } as unknown as GameState;
      const s = run(broken, ...put(a, p.solution[a]), ...put(b, wrongOf(p.solution[b]))).s;
      expect(s.mistakes, String(placed)).toBe(1);
      expect(s.placed, String(placed)).toBeUndefined();
      expect(s.firstMistake, String(placed)).toBeUndefined();
    }
  });

  it("それまでにミスがあれば（解答の無い日次で重複を数えたなど）、後の誤りは最初とは呼ばないので記録しない", () => {
    const p = generatePuzzle("first-mistake-nosolution", "easy");
    const s0 = newGame({
      mode: "daily",
      difficulty: "easy",
      seed: "2026-10-24",
      puzzle: p.puzzle,
      solution: null,
      daily: { sessionId: "s", date: "2026-10-24", startedAt: 0, clockOffset: 0 },
    });
    const [a, b] = empties(s0);
    // 解答が無いと正しい数字が分からないので記録しない（ミスには数える）
    const dupe = p.puzzle[PEERS[a].find((i) => p.puzzle[i] !== 0)!];
    const s = run(s0, ...put(a, dupe)).s;
    expect(s.mistakes).toBe(1);
    expect(s.firstMistake).toBeUndefined();
    const later = run(withSolution(s), ...put(b, wrongOf(p.solution[b]))).s;
    expect(later.mistakes).toBe(2);
    expect(later.firstMistake).toBeUndefined();
  });
});

describe("ミスの上限", () => {
  const p = generatePuzzle("mistake-limit", "easy");
  const empties = p.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const wrongOf = (i: number) => (p.solution[i] % 9) + 1;
  /** mode のゲームを、設定の上限 limit で始める（日次も解答を持たせる。開いたときに withSolution で付くのと同じ） */
  const start = (mode: Mode, limit: number) =>
    newGame({
      mode,
      difficulty: "easy",
      seed: mode === "daily" ? "2026-10-25" : "x",
      puzzle: p.puzzle,
      solution: p.solution,
      daily: mode === "daily" ? { sessionId: "s", date: "2026-10-25", startedAt: 0, clockOffset: 0 } : null,
      mistakeLimit: limit as MistakeLimit,
    });
  /** cell に数字を置く。show は間違いの表示の設定（dispatch が付けるもの） */
  const put = (cell: number, digit: number, show = true): Action[] => [
    { type: "select", cell },
    { type: "input", digit, showMistakes: show },
  ];
  /** 空きマスの from 番目から n マスに、違う数字を置く */
  const wrongs = (n: number, show = true, from = 0) =>
    empties.slice(from, from + n).flatMap((i) => put(i, wrongOf(i), show));

  it("効くのはフリープレイで、間違いの表示がオンのときだけ。日次と練習には上限を持たせない", () => {
    for (const mode of ["free", "daily", "practice"] as const) {
      for (const limit of MISTAKE_LIMITS) {
        const g = start(mode, limit);
        expect(g.mistakeLimit ?? 0, `${mode} ${limit}`).toBe(mode === "free" ? limit : 0);
        for (const show of [true, false]) {
          expect(activeMistakeLimit(g, show), `${mode} ${limit} ${show}`).toBe(
            mode === "free" && show ? limit : 0,
          );
        }
      }
      // 書き換えた保存データで日次・練習に上限が付いていても効かせない
      expect(activeMistakeLimit({ ...start(mode, 0), mistakeLimit: 3 }, true), mode).toBe(
        mode === "free" ? 3 : 0,
      );
    }
    // 上限なしでは、上限の項目を持たない
    expect(start("free", 0)).not.toHaveProperty("mistakeLimit");
  });

  it("ミスの数が上限に達した手で終える（failed）。上限の手前までは続けられる", () => {
    for (const limit of [3, 5] as const) {
      const before = run(start("free", limit), ...wrongs(limit - 1));
      expect(before.s.mistakes).toBe(limit - 1);
      expect(before.s.status).toBe("playing");
      expect(before.effects.map((e) => e.kind)).toEqual(["place"]);
      const last = empties[limit - 1];
      const { s, effects } = run(before.s, ...put(last, wrongOf(last)));
      expect(s.mistakes).toBe(limit);
      expect(s.status).toBe("failed");
      expect(s.selected).toBe(null);
      expect(s.values[last]).toBe(wrongOf(last));
      expect(effects).toEqual([
        expect.objectContaining({ kind: "place", cell: last, wrong: true }),
        { kind: "failed", cell: last },
      ]);
      // 終えた問題は続けられず、行き詰まりも知らせない
      expect(isInProgress(s)).toBe(false);
      expect(stuckCells(s)).toEqual([]);
    }
  });

  it("終えた後は、数字・メモ・消す・戻す・進む・ヒント・間違える前まで戻す・時計・一時停止が効かない", () => {
    const failed = run(start("free", 3), ...wrongs(3)).s;
    const cell = empties[5];
    const actions: Action[] = [
      { type: "select", cell },
      { type: "move", dr: 0, dc: 1 },
      { type: "input", digit: p.solution[cell], showMistakes: true },
      { type: "input", digit: 1, asNote: true },
      { type: "erase" },
      { type: "undo" },
      { type: "redo" },
      { type: "hint", showMistakes: true },
      { type: "hintUsed" },
      { type: "autoNotes" },
      { type: "rewind" },
      { type: "toggleNotes" },
      { type: "toggleColors" },
      { type: "tick", ms: 1000 },
      { type: "pause" },
      { type: "resume" },
      { type: "finalize", ms: 1000 },
    ];
    for (const a of actions) {
      const [next, effects] = reduce(failed, a);
      expect(next, a.type).toBe(failed);
      expect(effects, a.type).toEqual([]);
    }
  });

  it("戻す・進む・間違える前まで戻す・消すでミスは減らず、同じマスにもう一度間違えても数えて、上限で終える", () => {
    const [a, b] = empties;
    let s = run(start("free", 3), ...put(a, wrongOf(a)), { type: "undo" }, { type: "redo" }).s;
    expect(s.mistakes).toBe(1);
    s = run(s, { type: "rewind" }).s;
    expect(s.values[a]).toBe(0);
    expect(s.mistakes).toBe(1);
    s = run(s, ...put(a, wrongOf(a)), { type: "erase" }).s;
    expect(s.values[a]).toBe(0);
    expect(s.mistakes).toBe(2);
    expect(s.status).toBe("playing");
    const done = run(s, ...put(b, wrongOf(b))).s;
    expect(done).toMatchObject({ status: "failed", mistakes: 3 });
  });

  it("重複していても解答どおりの数字と、ヒントで置いた数字はミスに数えない", () => {
    const [a] = empties;
    // a と同じ行の空きマス b の正解を a に置く（間違い 1 回）。続けて b に正解を置くと、a と重複するが間違いではない
    const b = empties.find((i) => i !== a && Math.floor(i / 9) === Math.floor(a / 9));
    expect(b).toBeDefined();
    const one = run(start("free", 3), ...put(a, p.solution[b!])).s;
    expect(one.mistakes).toBe(1);
    const { s, effects } = run(one, ...put(b!, p.solution[b!]));
    expect(effects[0]).toMatchObject({ kind: "place", wrong: false, conflict: true });
    expect(s.mistakes).toBe(1);
    const hinted = run(
      s,
      { type: "hint", showMistakes: true },
      { type: "hint", showMistakes: true },
      { type: "hint", showMistakes: true },
    ).s;
    expect(hinted.hints).toBe(3);
    expect(hinted).toMatchObject({ status: "playing", mistakes: 1 });
  });

  it("間違いの表示がオフの間に数字を置くと（ヒントを含む）、その問題では上限を外す。オンに戻しても付け直さない", () => {
    const two = run(start("free", 3), ...wrongs(2)).s;
    const cell = empties[2];
    const offs: Action[][] = [
      put(cell, p.solution[cell], false),
      put(cell, wrongOf(cell), false),
      [{ type: "hint", cell, showMistakes: false }],
    ];
    for (const off of offs) {
      const { s } = run(two, ...off);
      expect(s.status).toBe("playing");
      expect(s.mistakeLimit).toBe(0);
      expect(activeMistakeLimit(s, true)).toBe(0);
      // 表示をオンに戻して、上限を超えて間違えても終えない（見えない間違いを上限に数えない）
      const after = run(s, ...wrongs(4, true, 3)).s;
      expect(after.status).toBe("playing");
      expect(after.mistakes).toBe(s.mistakes + 4);
    }
  });

  it("数字を置かなければ（選ぶ・メモ・消す・戻す・進む・色）、間違いの表示がオフでも上限は残る", () => {
    const c = empties[2];
    const two = run(start("free", 3), ...wrongs(2)).s;
    const s = run(
      two,
      { type: "select", cell: c },
      { type: "input", digit: 4, asNote: true, showMistakes: false },
      { type: "erase" },
      { type: "undo" },
      { type: "redo" },
      { type: "toggleColors" },
      { type: "input", digit: 2, showMistakes: false },
      { type: "toggleColors" },
    ).s;
    expect(s.mistakeLimit).toBe(3);
    expect(s.values[c]).toBe(0);
    expect(run(s, ...put(c, wrongOf(c))).s.status).toBe("failed");
  });

  it("日次と練習では、間違いの表示がオンで上限を超えて間違えても終えない", () => {
    for (const mode of ["daily", "practice"] as const) {
      // 書き換えた保存データで上限が付いていても効かせない
      const g = { ...start(mode, 0), mistakeLimit: 3 } as GameState;
      const { s, effects } = run(g, ...wrongs(6));
      expect(s.status, mode).toBe("playing");
      expect(s.mistakes, mode).toBe(6);
      expect(
        effects.map((e) => e.kind),
        mode,
      ).toEqual(["place"]);
    }
  });

  it("上限と終えた状態は、保存して開き直しても残る。途中の問題は同じ上限で続く", () => {
    const reopen = (s: GameState) => withSolution(JSON.parse(JSON.stringify(persisted(s))) as GameState);
    const failed = reopen(run(start("free", 5), ...wrongs(5)).s);
    expect(failed).toMatchObject({ status: "failed", mistakes: 5, mistakeLimit: 5 });
    expect(reduce(failed, { type: "select", cell: empties[6] })[0]).toBe(failed);
    const two = reopen(run(start("free", 3), ...wrongs(2)).s);
    expect(two).toMatchObject({ status: "playing", mistakes: 2, mistakeLimit: 3 });
    expect(run(two, ...put(empties[2], wrongOf(empties[2]))).s.status).toBe("failed");
  });

  it("上限を持たない古い保存データと、決まった値でない上限（書き換えたもの）は上限なしとして扱う", () => {
    const { mistakeLimit: _, ...old } = start("free", 3);
    expect(run(old as GameState, ...wrongs(6)).s).toMatchObject({ status: "playing", mistakes: 6 });
    for (const limit of [1, 4, 6, -3, 3.5, "3", "5", null, true, [3], { n: 3 }]) {
      const label = JSON.stringify(limit);
      expect(parseMistakeLimit(limit), label).toBe(0);
      // 設定から決まった値でないものが渡っても付けない
      expect(start("free", limit as number), label).not.toHaveProperty("mistakeLimit");
      const broken = { ...start("free", 0), mistakeLimit: limit } as unknown as GameState;
      expect(activeMistakeLimit(broken, true), label).toBe(0);
      expect(run(broken, ...wrongs(6)).s.status, label).toBe("playing");
    }
    expect(MISTAKE_LIMITS.map(parseMistakeLimit)).toEqual([0, 3, 5]);
  });

  it("同じ盤面でやり直すと、同じ問題の新しいゲームになる（ミス・手・最初の誤り・時間・色・メモを消す）。上限は今の設定", () => {
    // メモは、後で置く違う数字と同じだと周りのメモの自動消去で消えるので、それ以外の数字にする
    const note = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => !empties.slice(0, 3).some((i) => wrongOf(i) === d))!;
    const played = run(
      start("free", 3),
      { type: "tick", ms: 5000 },
      { type: "select", cell: empties[3] },
      { type: "toggleColors" },
      { type: "input", digit: 4 },
      { type: "toggleColors" },
      { type: "input", digit: note, asNote: true },
      ...wrongs(3),
    ).s;
    expect(played).toMatchObject({ status: "failed", mistakes: 3, elapsedMs: 5000, placed: 3 });
    expect(played.firstMistake).toBeDefined();
    expect(played.colors![empties[3]]).toBe(4);
    expect(played.notes[empties[3]]).toBe(1 << note);
    for (const limit of MISTAKE_LIMITS) {
      const again = restartGame(played, limit);
      expect(again).toEqual(start("free", limit));
      expect(again).toMatchObject({ status: "playing", mistakes: 0, history: [], placed: 0, elapsedMs: 0 });
      expect(again.values).toEqual(p.puzzle);
      expect(again.puzzle).not.toBe(played.puzzle);
      expect(again.firstMistake).toBeUndefined();
      expect(activeMistakeLimit(again, true)).toBe(limit);
    }
  });

  it("途中の問題は、遊んでいる・一時停止中のものだけ（解き終えた・上限で終えたものは続けられない）", () => {
    expect(
      (["playing", "paused", "solved", "failed"] as const).map((status) => isInProgress({ status })),
    ).toEqual([true, true, false, false]);
  });
});
