import {
  PEERS,
  UNITS,
  UNITS_OF,
  candidatesAt,
  findConflicts,
  type Difficulty,
  type Grid,
} from "@/lib/sudoku/core";

export type Mode = "free" | "daily";
export type Status = "playing" | "paused" | "solved";

export type GameState = {
  version: 1;
  mode: Mode;
  difficulty: Difficulty;
  /** フリープレイのシード、または日次の日付 */
  seed: string;
  puzzle: Grid;
  /** フリープレイのみ。日次では解答を持たない */
  solution: Grid | null;
  values: Grid;
  /** マスごとのメモ（bit1〜bit9） */
  notes: number[];
  selected: number | null;
  notesMode: boolean;
  history: Move[];
  mistakes: number;
  hints: number;
  /** フリープレイの経過時間（一時停止を除く） */
  elapsedMs: number;
  status: Status;
  /** 日次：解き終えた時点の経過時間（表示用。記録はサーバーが測る） */
  finalMs: number | null;
  /** 日次：サーバーのセッション */
  daily: { sessionId: string; date: string; startedAt: number; clockOffset: number } | null;
};

type Move = {
  cell: number;
  prevValue: number;
  prevNotes: number;
  /** 数字を置いたときに周りのメモから消した分 */
  clearedNotes: [number, number][];
};

/** 入力の結果。音・アニメーションの出し分けに使う */
export type Effect =
  | { kind: "place"; cell: number; digit: number; wrong: boolean; units: number[][] }
  | { kind: "note"; cell: number; digit: number; on: boolean }
  | { kind: "erase"; cell: number }
  | { kind: "undo"; cell: number }
  | { kind: "hint"; cell: number; digit: number; units: number[][] }
  | { kind: "solved" }
  | { kind: "blocked" };

export type Action =
  | { type: "select"; cell: number | null }
  | { type: "move"; dr: number; dc: number }
  | { type: "input"; digit: number; asNote?: boolean }
  | { type: "erase" }
  | { type: "undo" }
  | { type: "hint" }
  | { type: "toggleNotes" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "tick"; ms: number }
  | { type: "finalize"; ms: number };

export function newGame(input: {
  mode: Mode;
  difficulty: Difficulty;
  seed: string;
  puzzle: Grid;
  solution: Grid | null;
  daily?: GameState["daily"];
}): GameState {
  return {
    version: 1,
    mode: input.mode,
    difficulty: input.difficulty,
    seed: input.seed,
    puzzle: input.puzzle.slice(),
    solution: input.solution ? input.solution.slice() : null,
    values: input.puzzle.slice(),
    notes: Array(81).fill(0),
    selected: null,
    notesMode: false,
    history: [],
    mistakes: 0,
    hints: 0,
    elapsedMs: 0,
    status: "playing",
    finalMs: null,
    daily: input.daily ?? null,
  };
}

export const isGiven = (s: GameState, i: number) => s.puzzle[i] !== 0;

/** その数字が間違いか。フリープレイは解答と比べ、日次は重複の有無で判断する */
export function isWrong(s: GameState, i: number, values: Grid = s.values): boolean {
  const v = values[i];
  if (!v || isGiven(s, i)) return false;
  if (s.solution) return s.solution[i] !== v;
  return PEERS[i].some((p) => values[p] === v);
}

/** 置いたことで揃ったユニット（行・列・ブロック）。全マスが埋まり、間違いが無いもの */
function completedUnits(s: GameState, values: Grid, cell: number): number[][] {
  const out: number[][] = [];
  for (const u of UNITS_OF[cell]) {
    const unit = UNITS[u];
    if (unit.every((i) => values[i] !== 0 && !isWrong(s, i, values))) out.push(unit);
  }
  return out;
}

export function isSolved(s: GameState, values: Grid = s.values): boolean {
  if (values.some((v) => v === 0)) return false;
  if (s.solution) return values.every((v, i) => v === s.solution![i]);
  return findConflicts(values).size === 0;
}

function place(s: GameState, cell: number, digit: number, viaHint: boolean): [GameState, Effect[]] {
  const values = s.values.slice();
  const notes = s.notes.slice();
  const move: Move = { cell, prevValue: values[cell], prevNotes: notes[cell], clearedNotes: [] };
  values[cell] = digit;
  notes[cell] = 0;
  const bit = 1 << digit;
  for (const p of PEERS[cell]) {
    if (notes[p] & bit) {
      move.clearedNotes.push([p, notes[p]]);
      notes[p] &= ~bit;
    }
  }
  const wrong = !viaHint && isWrong(s, cell, values);
  const next: GameState = {
    ...s,
    values,
    notes,
    history: [...s.history, move],
    mistakes: s.mistakes + (wrong ? 1 : 0),
    hints: s.hints + (viaHint ? 1 : 0),
  };
  const units = wrong ? [] : completedUnits(next, values, cell);
  const effects: Effect[] = [
    viaHint ? { kind: "hint", cell, digit, units } : { kind: "place", cell, digit, wrong, units },
  ];
  if (isSolved(next, values)) {
    next.status = "solved";
    next.selected = null;
    effects.push({ kind: "solved" });
  }
  return [next, effects];
}

export function reduce(s: GameState, action: Action): [GameState, Effect[]] {
  if (action.type === "tick") {
    if (s.status !== "playing" || s.mode !== "free") return [s, []];
    return [{ ...s, elapsedMs: s.elapsedMs + action.ms }, []];
  }
  if (action.type === "finalize") {
    return s.status === "solved" && s.finalMs === null ? [{ ...s, finalMs: action.ms }, []] : [s, []];
  }
  if (action.type === "pause") {
    return s.status === "playing" && s.mode === "free" ? [{ ...s, status: "paused" }, []] : [s, []];
  }
  if (action.type === "resume") {
    return s.status === "paused" ? [{ ...s, status: "playing" }, []] : [s, []];
  }
  if (s.status !== "playing") return [s, []];

  switch (action.type) {
    case "select":
      return [{ ...s, selected: action.cell }, []];
    case "move": {
      const cur = s.selected ?? 40;
      const r = (Math.floor(cur / 9) + action.dr + 9) % 9;
      const c = ((cur % 9) + action.dc + 9) % 9;
      return [{ ...s, selected: r * 9 + c }, []];
    }
    case "toggleNotes":
      return [{ ...s, notesMode: !s.notesMode }, []];
    case "input": {
      const cell = s.selected;
      if (cell === null || isGiven(s, cell)) return [s, [{ kind: "blocked" }]];
      const asNote = action.asNote ?? s.notesMode;
      if (asNote) {
        if (s.values[cell]) return [s, [{ kind: "blocked" }]];
        const bit = 1 << action.digit;
        const notes = s.notes.slice();
        notes[cell] ^= bit;
        const move: Move = { cell, prevValue: 0, prevNotes: s.notes[cell], clearedNotes: [] };
        return [
          { ...s, notes, history: [...s.history, move] },
          [{ kind: "note", cell, digit: action.digit, on: (notes[cell] & bit) !== 0 }],
        ];
      }
      if (s.values[cell] === action.digit) return erase(s, cell);
      return place(s, cell, action.digit, false);
    }
    case "erase": {
      const cell = s.selected;
      if (cell === null || isGiven(s, cell)) return [s, [{ kind: "blocked" }]];
      return erase(s, cell);
    }
    case "undo": {
      const move = s.history[s.history.length - 1];
      if (!move) return [s, [{ kind: "blocked" }]];
      const values = s.values.slice();
      const notes = s.notes.slice();
      values[move.cell] = move.prevValue;
      notes[move.cell] = move.prevNotes;
      for (const [p, mask] of move.clearedNotes) notes[p] = mask;
      return [
        { ...s, values, notes, history: s.history.slice(0, -1), selected: move.cell },
        [{ kind: "undo", cell: move.cell }],
      ];
    }
    case "hint": {
      if (!s.solution) return [s, [{ kind: "blocked" }]];
      const cell = pickHintCell(s);
      if (cell === null) return [s, [{ kind: "blocked" }]];
      const [next, effects] = place({ ...s, selected: cell }, cell, s.solution[cell], true);
      return [next, effects];
    }
  }
}

function erase(s: GameState, cell: number): [GameState, Effect[]] {
  if (!s.values[cell] && !s.notes[cell]) return [s, [{ kind: "blocked" }]];
  const values = s.values.slice();
  const notes = s.notes.slice();
  const move: Move = { cell, prevValue: values[cell], prevNotes: notes[cell], clearedNotes: [] };
  values[cell] = 0;
  notes[cell] = 0;
  return [{ ...s, values, notes, history: [...s.history, move] }, [{ kind: "erase", cell }]];
}

/** ヒントを出すマス：選択中のマスが空きか間違いならそこ、無ければ候補が最も少ない空きマス */
function pickHintCell(s: GameState): number | null {
  const sel = s.selected;
  if (sel !== null && !isGiven(s, sel) && (s.values[sel] === 0 || isWrong(s, sel))) return sel;
  let best: number | null = null;
  let bestCount = 10;
  const clean = s.values.map((v, i) => (isWrong(s, i) ? 0 : v));
  for (let i = 0; i < 81; i++) {
    if (s.values[i] !== 0 && !isWrong(s, i)) continue;
    let n = 0;
    for (let m = candidatesAt(clean, i); m; m &= m - 1) n++;
    if (n < bestCount) {
      best = i;
      bestCount = n;
    }
  }
  return best;
}

/** 日次の経過時間はサーバーの開始時刻から数える（一時停止なし） */
export function elapsedOf(s: GameState, now = Date.now()): number {
  if (s.finalMs !== null) return s.finalMs;
  if (s.mode === "daily" && s.daily) return Math.max(0, now + s.daily.clockOffset - s.daily.startedAt);
  return s.elapsedMs;
}

export function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
