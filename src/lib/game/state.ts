import { countSolutionsWithin, solve } from "@/lib/sudoku/solver";
import {
  applyPlacement,
  emptyScore,
  timeBonus,
  type MoveLog,
  type ScoreDelta,
  type ScoreState,
} from "./score";
import { candidatesOf, findAllSteps, type TechniqueId } from "@/lib/sudoku/logic";
import {
  PEERS,
  UNITS,
  UNITS_OF,
  candidatesAt,
  findConflicts,
  type Difficulty,
  type Grid,
} from "@/lib/sudoku/core";

/**
 * practice は手筋の練習。保存せず、記録・統計にも入れない。時計は進めず、一時停止も解き終えもしない。
 * ヒントと自動メモの制限は日次だけ
 */
export type Mode = "free" | "daily" | "practice";

/** 間違える前まで戻すときに、1 つの盤面が解けるかを確かめる置く回数の上限（作った問題なら数千回で終わる） */
export const REWIND_MAX_NODES = 200_000;
export type Status = "playing" | "paused" | "solved";

export type GameState = {
  version: 1;
  mode: Mode;
  difficulty: Difficulty;
  /** フリープレイのシード（共有された盤面は shared:盤面）、または日次の日付 */
  seed: string;
  puzzle: Grid;
  /**
   * 解答。フリープレイは作ったときのもの、日次は端末で解いたもの（サーバーからは受け取らない）。
   * 古い保存データの日次には無いことがある
   */
  solution: Grid | null;
  values: Grid;
  /** マスごとのメモ（bit1〜bit9） */
  notes: number[];
  selected: number | null;
  /**
   * selected に足して選んだマス（selected は含まない）。2 マス以上選んでいる間、数字と消すはメモに効く。保存しない。
   * 空配列にはしない（1 マスだけなら undefined）ので、複数選択かは真偽で判断できる
   */
  selection?: number[];
  notesMode: boolean;
  /**
   * マスの色（0 は色なし、1〜9 は色の番号）。解く過程の目印で、点数・手の記録には関わらず、サーバーにも送らない。
   * 古い保存データには無い
   */
  colors?: number[];
  /** 色モード。数字と消すが選んだマスの色に効く。メモモードとは同時にオンにならない */
  colorMode?: boolean;
  history: Move[];
  /** 元に戻した手（最後が次に進む手）。保存しない */
  future?: Undone[];
  mistakes: number;
  hints: number;
  /** フリープレイの経過時間（一時停止を除く） */
  elapsedMs: number;
  status: Status;
  /** 日次：解き終えた時点の経過時間（表示用。記録はサーバーが測る） */
  finalMs: number | null;
  /** 日次：サーバーのセッション */
  daily: { sessionId: string; date: string; startedAt: number; clockOffset: number } | null;
  /** スコア。古い保存データには無い（開いたときに withSolution で付ける） */
  score?: ScoreState;
  /** 日次：置いた手の記録。提出時にサーバーへ送り、サーバーがスコアを計算し直す */
  moves?: MoveLog;
  /**
   * 数字を置いた回数（ヒントで置いた分を含む）。最初の誤りの「何手目」に使う。
   * メモ・消す・色・戻す・進む・間違える前まで戻すでは変えない（戻しても置いた事実は残る）。
   * 古い保存データには無く、そのときは数えない（それまでの回数が分からないので、最初の誤りも記録しない）。
   * 整数でない値（書き換えた保存データ）も無いものとして扱う
   */
  placed?: number;
  /** 最初に置いた、解答と違う数字（クリアの結果で振り返る）。無ければ undefined */
  firstMistake?: FirstMistake;
};

/**
 * 最初の誤り。間違いの表示の設定に関わらず記録し、戻す・消す・間違える前まで戻すで盤面から消えても残す
 * （ミスの数と同じく、置いた事実として数える）。端末の保存データにだけ入り、サーバーには送らない
 */
export type FirstMistake = {
  /** 何手目か（placed で数える。1 始まり） */
  move: number;
  cell: number;
  /** 置いた数字 */
  digit: number;
  /** 正しい数字 */
  answer: number;
  /** 置く直前の盤面の数字だけから、そのマスに正しい数字を 1 手で置けた手筋。無ければ null */
  technique: SingleTechnique | null;
};

/** 1 手で数字を置ける手筋（findAllSteps で置く手になるのはこの 2 つだけ） */
export type SingleTechnique = Extract<TechniqueId, "naked-single" | "hidden-single">;

export const isSingleTechnique = (x: unknown): x is SingleTechnique =>
  x === "naked-single" || x === "hidden-single";

type Move = {
  cell: number;
  prevValue: number;
  prevNotes: number;
  /** 数字を置いたときに周りのメモから消した分 */
  clearedNotes: [number, number][];
  /** 自動メモなど、メモをまとめて変えたときの元のメモ（cell は -1） */
  bulkNotes?: number[];
  /** 色を変えたときの元の色（cell は -1） */
  bulkColors?: number[];
};

/** 元に戻した手と、戻す前の盤面とメモと色。元に戻すは最後の手から順なので、戻す前の盤面はその手を打った直後と同じ */
type Undone = { move: Move; values: Grid; notes: number[]; colors?: number[] };

/** 入力の結果。音・アニメーションの出し分けに使う */
export type Effect =
  | {
      kind: "place";
      cell: number;
      digit: number;
      /** 解答と違う */
      wrong: boolean;
      /** 同じ行・列・ブロックに同じ数字がある */
      conflict: boolean;
      units: number[][];
      /** この手の得点（減点はマイナス）とユニットのボーナス */
      points: number;
      bonus: number;
    }
  | { kind: "note"; cell: number; digit: number; on: boolean }
  /** 選んだマスに色を付けた（on）か外した */
  | { kind: "color"; color: number; on: boolean }
  | { kind: "erase"; cell: number }
  | { kind: "undo"; cell: number }
  | { kind: "redo"; cell: number }
  | { kind: "hint"; cell: number; digit: number; units: number[][]; bonus: number }
  /** timeBonus は解き終えたときの時間ボーナス（日次はサーバーが測り直す） */
  | { kind: "solved"; cell: number; timeBonus: number }
  | { kind: "rewind"; steps: number }
  | { kind: "notes"; filled: boolean }
  | { kind: "blocked" };

export type Action =
  | { type: "select"; cell: number | null }
  /** なぞったマスを選択に足す */
  | { type: "extendSelection"; cell: number }
  /** 修飾キー付きクリック：選択にマスを足す・外す */
  | { type: "toggleSelection"; cell: number }
  /** from は選んでいるマスが無いときの起点（フォーカスしているマス）。省略時は中央 */
  | { type: "move"; dr: number; dc: number; from?: number }
  /**
   * t は開始からの経過 ms（スコアの速さに使う）。clearPeers は周りのメモからその数字を消すか（省略時は消す）。
   * どちらも dispatch 側で付ける
   */
  | { type: "input"; digit: number; asNote?: boolean; t?: number; clearPeers?: boolean }
  /** colors は色を外すか（省略時は色モードに従う）。手筋ヒントの「消す」は数字を消すので false を付ける */
  | { type: "erase"; colors?: boolean }
  | { type: "undo" }
  /** 元に戻した手をやり直す */
  | { type: "redo" }
  /** cell を指定すると、そのマスに正解を置く（手筋ヒントの「置く」） */
  | { type: "hint"; t?: number; cell?: number; clearPeers?: boolean }
  /** メモをまとめて置き換える（手筋ヒントの「メモに反映」） */
  | { type: "setNotes"; notes: number[] }
  /** 自動メモ：候補をすべて書く。すでに候補どおりなら全部消す */
  | { type: "autoNotes" }
  /** ヒントを見た（回数を数え、コンボを切る） */
  | { type: "hintUsed" }
  | { type: "toggleNotes" }
  | { type: "toggleColors" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "rewind" }
  | { type: "tick"; ms: number }
  | { type: "finalize"; ms: number };

export function newGame(input: {
  mode: Mode;
  difficulty: Difficulty;
  seed: string;
  puzzle: Grid;
  solution: Grid | null;
  daily?: GameState["daily"];
  /** 始めのメモ（練習の局面）。省略するとメモなし */
  notes?: number[];
}): GameState {
  return {
    version: 1,
    mode: input.mode,
    difficulty: input.difficulty,
    seed: input.seed,
    puzzle: input.puzzle.slice(),
    solution: input.solution ? input.solution.slice() : null,
    values: input.puzzle.slice(),
    notes: input.notes ? input.notes.slice() : Array(81).fill(0),
    selected: null,
    notesMode: false,
    colors: Array(81).fill(0),
    colorMode: false,
    history: [],
    mistakes: 0,
    hints: 0,
    elapsedMs: 0,
    status: "playing",
    finalMs: null,
    daily: input.daily ?? null,
    score: emptyScore(input.puzzle),
    moves: [],
    placed: 0,
  };
}

export const isGiven = (s: GameState, i: number) => s.puzzle[i] !== 0;

/** 選んでいるマスすべて（基準のマスが先頭） */
export const selectedCells = (s: GameState): number[] =>
  s.selected === null ? [] : [s.selected, ...(s.selection ?? [])];

/** 選んでいるマスを cells にする（先頭が基準のマス） */
const withCells = (s: GameState, cells: number[]): GameState => ({
  ...s,
  selected: cells[0] ?? null,
  selection: cells.length > 1 ? cells.slice(1) : undefined,
});

/** 1 マスだけ選ぶ（null なら選択を外す） */
const pickOne = (s: GameState, cell: number | null): GameState => withCells(s, cell === null ? [] : [cell]);

/** 保存する形。選択と進む手は保存しない */
export const persisted = (g: GameState) => ({
  ...g,
  selected: null,
  selection: undefined,
  future: undefined,
});

/**
 * 解答とスコアを持っていなければ付ける（日次・古い保存データ用）。
 * スコアが無い古いデータでは、すでに正しく埋まっているマスを 0 点の得点済みとして扱う
 */
export function withSolution(s: GameState): GameState {
  const solution = s.solution ?? solve(s.puzzle);
  if (!solution) return s;
  let score = s.score;
  if (!score) {
    const base = emptyScore(s.puzzle);
    score = {
      ...base,
      scored: s.values.map((v, i) => (v && v === solution[i] ? "1" : base.scored[i])).join(""),
    };
  }
  if (solution === s.solution && score === s.score) return s;
  return { ...s, solution, score, moves: s.moves ?? [] };
}

/** その数字が間違いか。フリープレイは解答と比べ、日次は重複の有無で判断する */
export function isWrong(s: GameState, i: number, values: Grid = s.values): boolean {
  const v = values[i];
  if (!v || isGiven(s, i)) return false;
  if (s.solution) return s.solution[i] !== v;
  return PEERS[i].some((p) => values[p] === v);
}

/**
 * 間違いとして見せるか（赤くする・揺らす・読み上げで「間違い」と言う）。
 * conflict は同じ行・列・ブロックに同じ数字があるか、wrong は解答と違うか。重複はいつも、解答と違うだけなら showMistakes のときだけ
 */
export const isShownWrong = (m: { conflict: boolean; wrong: boolean }, showMistakes: boolean): boolean =>
  m.conflict || (m.wrong && showMistakes);

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

/** 手を積む。新しい手を打ったら、元に戻した手には進めなくなる */
function commit(s: GameState, move: Move, patch: Partial<GameState>): GameState {
  return { ...s, ...patch, history: [...s.history, move], future: [] };
}

/** まとめて変えた手（cell は -1）。元のメモか色を持たせる */
const bulkMove = (prev: Pick<Move, "bulkNotes" | "bulkColors">): Move => ({
  cell: -1,
  prevValue: 0,
  prevNotes: 0,
  clearedNotes: [],
  ...prev,
});

/** メモをまとめて変えた手を積む（点数・手の記録には触れない） */
function commitNotes(s: GameState, notes: number[], effect: Effect): [GameState, Effect[]] {
  return [commit(s, bulkMove({ bulkNotes: s.notes }), { notes }), [effect]];
}

/**
 * 置く直前の盤面の数字だけから、cell に answer を 1 手で置ける手筋（findAllSteps の順で最初のもの）。無ければ null。
 * 候補は盤面の数字から出し、メモは見ない。cell は空けて調べる（正しい数字を間違いで上書きしたときも、空きと同じに扱う）。
 * まだミスが無い盤面で呼ぶので、盤面の数字はどれも正しく、候補に答えが残る。置ける手になるのはシングルだけ。
 * 最初の誤りの 1 回だけ呼ぶ（findAllSteps は途中の盤面で 1 回 0.2〜2ms ほど。手元の Mac）
 */
function singleAt(values: Grid, cell: number, answer: number): SingleTechnique | null {
  const grid = values.slice();
  grid[cell] = 0;
  const technique = findAllSteps(grid, candidatesOf(grid)).find(
    (st) => st.placement?.cell === cell && st.placement.digit === answer,
  )?.trace.technique;
  return isSingleTechnique(technique) ? technique : null;
}

/** マスの色。古い保存データには無いので、そのときは色なしとして扱う */
const colorsOf = (s: GameState): number[] => s.colors ?? Array<number>(81).fill(0);

function place(
  s: GameState,
  cell: number,
  digit: number,
  viaHint: boolean,
  t: number,
  /** ヒントの回数を数えるか（手筋ヒントは開いたときに数え済み） */
  countHint = true,
  /** 周りのメモからこの数字を消すか。消さなければ元に戻すときも周りのメモには触れない */
  clearPeers: boolean,
): [GameState, Effect[]] {
  const values = s.values.slice();
  const notes = s.notes.slice();
  const move: Move = { cell, prevValue: values[cell], prevNotes: notes[cell], clearedNotes: [] };
  values[cell] = digit;
  notes[cell] = 0;
  const bit = 1 << digit;
  if (clearPeers) {
    for (const p of PEERS[cell]) {
      if (notes[p] & bit) {
        move.clearedNotes.push([p, notes[p]]);
        notes[p] &= ~bit;
      }
    }
  }
  const wrong = !viaHint && isWrong(s, cell, values);
  const conflict = PEERS[cell].some((p) => values[p] === digit);
  let score = s.score;
  let delta: ScoreDelta | null = null;
  if (s.solution && score)
    [score, delta] = applyPlacement(score, { cell, digit, t, viaHint }, s.solution, s.difficulty);
  // 回数を持たない・整数でない（古い・書き換えた保存データ）なら数えない
  const placed = Number.isInteger(s.placed) ? s.placed! + 1 : undefined;
  // 最初の誤りは、まだミスが無いときだけ記録する（古い保存データでそれまでにミスがあれば、後の誤りは最初ではない）。
  // 練習は結果を出さないので記録しない
  const answer = s.solution?.[cell];
  const firstMistake: FirstMistake | undefined =
    wrong && answer && s.mistakes === 0 && placed !== undefined && s.mode !== "practice"
      ? { move: placed, cell, digit, answer, technique: singleAt(s.values, cell, answer) }
      : s.firstMistake;
  const next = commit(s, move, {
    values,
    notes,
    mistakes: s.mistakes + (wrong ? 1 : 0),
    hints: s.hints + (viaHint && countHint ? 1 : 0),
    score,
    // 日次はサーバーで計算し直すので、置いた手を残す
    moves: s.mode === "daily" && !viaHint ? [...(s.moves ?? []), [Math.round(t), cell, digit]] : s.moves,
    placed,
    firstMistake,
  });
  const units = wrong ? [] : completedUnits(next, values, cell);
  const effects: Effect[] = [
    viaHint
      ? { kind: "hint", cell, digit, units, bonus: delta?.bonus ?? 0 }
      : {
          kind: "place",
          cell,
          digit,
          wrong,
          conflict,
          units,
          points: delta?.points ?? 0,
          bonus: delta?.bonus ?? 0,
        },
  ];
  // 練習は解き終えにしない（結果・効果音・盤面の波を出さない）
  if (s.mode !== "practice" && isSolved(next, values)) {
    const bonus = next.score ? timeBonus(s.difficulty, s.puzzle, t) : 0;
    if (next.score) next.score = { ...next.score, points: next.score.points + bonus, timeBonus: bonus };
    next.status = "solved";
    next.selected = null;
    effects.push({ kind: "solved", cell, timeBonus: bonus });
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
      return [pickOne(s, action.cell), []];
    case "extendSelection":
    case "toggleSelection": {
      const { cell } = action;
      const cells = selectedCells(s);
      if (!cells.includes(cell)) return [withCells(s, [...cells, cell]), []];
      // なぞったマスが選んであれば変えない。修飾キーなら外す
      if (action.type === "extendSelection") return [s, []];
      const rest = cells.filter((i) => i !== cell);
      // 基準のマスを外したら、最後に足したマスを基準にする。1 マスだけなら選択が無くなる
      return [withCells(s, cell === s.selected ? [...rest.slice(-1), ...rest.slice(0, -1)] : rest), []];
    }
    case "move": {
      const cur = s.selected ?? action.from ?? 40;
      const r = (Math.floor(cur / 9) + action.dr + 9) % 9;
      const c = ((cur % 9) + action.dc + 9) % 9;
      return [pickOne(s, r * 9 + c), []];
    }
    case "toggleNotes":
      return [{ ...s, notesMode: !s.notesMode, colorMode: false }, []];
    case "toggleColors":
      return [{ ...s, colorMode: !s.colorMode, notesMode: false }, []];
    case "input": {
      // 色モードでは、数字を色の番号として選んだマスに塗る（複数選択でも、Shift+数字でも）
      if (s.colorMode) return paint(s, action.digit);
      // 2 マス以上選んでいるときは、メモモードに関わらずメモとして扱う
      if (s.selection) return noteSelection(s, action.digit);
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
          commit(s, move, { notes }),
          [{ kind: "note", cell, digit: action.digit, on: (notes[cell] & bit) !== 0 }],
        ];
      }
      if (s.values[cell] === action.digit) return erase(s, cell);
      return place(s, cell, action.digit, false, action.t ?? 0, true, action.clearPeers ?? true);
    }
    case "erase": {
      if (action.colors ?? s.colorMode) return eraseColors(s);
      if (s.selection) return eraseSelectionNotes(s);
      const cell = s.selected;
      if (cell === null || isGiven(s, cell)) return [s, [{ kind: "blocked" }]];
      return erase(s, cell);
    }
    case "undo": {
      const move = s.history[s.history.length - 1];
      if (!move) return [s, [{ kind: "blocked" }]];
      const future = [...(s.future ?? []), { move, values: s.values, notes: s.notes, colors: s.colors }];
      return [{ ...undoOnce(s), future }, [{ kind: "undo", cell: move.cell }]];
    }
    case "redo": {
      // 戻す前の盤面に戻すだけで、得点・手の記録・ミス・置いた回数・最初の誤りには触れない（元に戻すもそれらを戻さない）
      const future = s.future ?? [];
      const entry = future[future.length - 1];
      if (!entry) return [s, [{ kind: "blocked" }]];
      const { move, values, notes, colors } = entry;
      const next = {
        ...s,
        values,
        notes,
        colors,
        history: [...s.history, move],
        future: future.slice(0, -1),
      };
      // まとめて変えたメモや色の手なら選択はそのまま、1 マスの手ならそのマスを選ぶ
      return [
        move.bulkNotes || move.bulkColors ? next : pickOne(next, move.cell),
        [{ kind: "redo", cell: move.cell }],
      ];
    }
    case "rewind": {
      // 正解にたどり着ける最後の時点まで、手順を逆にたどって戻す。
      // 置く回数の上限までに解けるか確かめ終わらない盤面では、そこで止める（確かめられない手まで消さない。
      // 共有された盤面は外から来るので、探索が重いことがある）
      let cur = s;
      let steps = 0;
      while (cur.history.length > 0 && countSolutionsWithin(cur.values, 1, REWIND_MAX_NODES) === 0) {
        cur = undoOnce(cur);
        steps++;
      }
      if (steps === 0) return [s, [{ kind: "blocked" }]];
      // 進むで行き詰まった盤面に戻れないようにする
      return [{ ...cur, future: [] }, [{ kind: "rewind", steps }]];
    }
    // ヒント・自動メモが使えないのは日次だけ（練習では手筋の答え合わせに使う）
    case "hintUsed": {
      if (s.mode === "daily") return [s, [{ kind: "blocked" }]];
      return [{ ...s, hints: s.hints + 1, score: s.score ? { ...s.score, streak: 0 } : s.score }, []];
    }
    case "setNotes": {
      if (s.mode === "daily") return [s, [{ kind: "blocked" }]];
      const notes = action.notes.map((n, i) => (s.values[i] ? 0 : n));
      return commitNotes(s, notes, { kind: "notes", filled: true });
    }
    case "autoNotes": {
      if (s.mode === "daily") return [s, [{ kind: "blocked" }]];
      const full = candidatesOf(s.values);
      const isFull = s.notes.every((n, i) => s.values[i] || n === full[i]);
      const notes = isFull ? Array<number>(81).fill(0) : full;
      return commitNotes(s, notes, { kind: "notes", filled: !isFull });
    }
    case "hint": {
      if (s.mode === "daily" || !s.solution) return [s, [{ kind: "blocked" }]];
      const cell =
        action.cell !== undefined &&
        !isGiven(s, action.cell) &&
        s.values[action.cell] !== s.solution[action.cell]
          ? action.cell
          : pickHintCell(s);
      if (cell === null) return [s, [{ kind: "blocked" }]];
      const [next, effects] = place(
        pickOne(s, cell),
        cell,
        s.solution[cell],
        true,
        action.t ?? 0,
        action.cell === undefined,
        action.clearPeers ?? true,
      );
      return [next, effects];
    }
  }
}

function undoOnce(s: GameState): GameState {
  const move = s.history[s.history.length - 1];
  if (!move) return s;
  if (move.bulkNotes) return { ...s, notes: move.bulkNotes.slice(), history: s.history.slice(0, -1) };
  if (move.bulkColors) return { ...s, colors: move.bulkColors.slice(), history: s.history.slice(0, -1) };
  const values = s.values.slice();
  const notes = s.notes.slice();
  values[move.cell] = move.prevValue;
  notes[move.cell] = move.prevNotes;
  for (const [p, mask] of move.clearedNotes) notes[p] = mask;
  return pickOne({ ...s, values, notes, history: s.history.slice(0, -1) }, move.cell);
}

/**
 * 行き詰まったマス：空いているのに入る数字が 1 つもないマス。
 * すべて埋まっているのに解けていないときは、重複しているマスを返す。
 */
export function stuckCells(s: GameState): number[] {
  if (s.status === "solved") return [];
  const out: number[] = [];
  let empty = 0;
  for (let i = 0; i < 81; i++) {
    if (s.values[i]) continue;
    empty++;
    if (candidatesAt(s.values, i) === 0) out.push(i);
  }
  if (empty === 0 && !isSolved(s)) return [...findConflicts(s.values)];
  return out;
}

function erase(s: GameState, cell: number): [GameState, Effect[]] {
  if (!s.values[cell] && !s.notes[cell]) return [s, [{ kind: "blocked" }]];
  const values = s.values.slice();
  const notes = s.notes.slice();
  const move: Move = { cell, prevValue: values[cell], prevNotes: notes[cell], clearedNotes: [] };
  values[cell] = 0;
  notes[cell] = 0;
  return [commit(s, move, { values, notes }), [{ kind: "erase", cell }]];
}

/** 選んだマスのうち、数字の入っていないもの */
const emptySelectedCells = (s: GameState) => selectedCells(s).filter((i) => !s.values[i]);

/** cells のメモを edit で書き換え、まとめて変えたメモとして 1 手に積む。cells が空なら何もしない */
function editNotes(
  s: GameState,
  cells: number[],
  edit: (mask: number) => number,
  effect: Effect,
): [GameState, Effect[]] {
  if (!cells.length) return [s, [{ kind: "blocked" }]];
  const notes = s.notes.slice();
  for (const i of cells) notes[i] = edit(notes[i]);
  return commitNotes(s, notes, effect);
}

/**
 * 選んだ空きマスのメモにまとめて付け外しする。すべてにあれば全部から消し、どれかに無ければ全部に足す。
 * 数字のあるマスは飛ばす
 */
function noteSelection(s: GameState, digit: number): [GameState, Effect[]] {
  const cells = emptySelectedCells(s);
  const bit = 1 << digit;
  const on = cells.some((i) => !(s.notes[i] & bit));
  return editNotes(s, cells, (m) => (on ? m | bit : m & ~bit), { kind: "note", cell: -1, digit, on });
}

/** 選んだ空きマスのメモだけを消す（数字は消さない） */
function eraseSelectionNotes(s: GameState): [GameState, Effect[]] {
  const cells = emptySelectedCells(s).filter((i) => s.notes[i]);
  return editNotes(s, cells, () => 0, { kind: "erase", cell: -1 });
}

/**
 * cells の色を to（0 は色なし）にし、まとめて変えた色として 1 手に積む（点数・手の記録には触れない）。
 * cells が空なら何もしない
 */
function editColors(s: GameState, cells: number[], to: number, effect: Effect): [GameState, Effect[]] {
  if (!cells.length) return [s, [{ kind: "blocked" }]];
  const prev = colorsOf(s);
  const colors = prev.slice();
  for (const i of cells) colors[i] = to;
  return [commit(s, bulkMove({ bulkColors: prev }), { colors }), [effect]];
}

/**
 * 選んだマスすべてに色を付ける。すべてがすでにその色なら全部から外す。
 * 最初から入っているマスや数字のあるマスにも付けられる
 */
function paint(s: GameState, color: number): [GameState, Effect[]] {
  const cells = selectedCells(s);
  const colors = colorsOf(s);
  const on = cells.some((i) => colors[i] !== color);
  return editColors(s, cells, on ? color : 0, { kind: "color", color, on });
}

/** 選んだマスの色だけを外す（数字とメモは消さない） */
function eraseColors(s: GameState): [GameState, Effect[]] {
  const colors = colorsOf(s);
  const cells = selectedCells(s).filter((i) => colors[i]);
  return editColors(s, cells, 0, { kind: "erase", cell: -1 });
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
