import { PEERS, UNITS, type Grid } from "./core";
import { candidatesOf, findNextStep, type TechniqueId } from "./logic";

/**
 * フリープレイのヒント。次に使える手筋を見つけ、段階的に見せるための情報を返す。
 *  1 段目: 手筋の名前と、注目するユニット（focus）
 *  2 段目: 根拠になるマス（pattern）と、置ける・消せるマス（targets）と説明文
 *  3 段目: 置く／メモに反映する
 */
export type Hint =
  | { kind: "wrong"; cell: number; title: string; text: string; focus: number[]; targets: number[] }
  | {
      kind: "place";
      technique: TechniqueId;
      title: string;
      text: string;
      focus: number[];
      pattern: number[];
      targets: number[];
      cell: number;
      digit: number;
    }
  | {
      kind: "eliminate";
      technique: TechniqueId;
      title: string;
      text: string;
      focus: number[];
      pattern: number[];
      targets: number[];
      eliminations: { cell: number; digit: number }[];
    }
  | {
      kind: "guess";
      title: string;
      text: string;
      focus: number[];
      targets: number[];
      cell: number;
      digit: number;
    };

export const TECHNIQUE_NAME: Record<TechniqueId, string> = {
  "naked-single": "ネイキッドシングル",
  "hidden-single": "ヒドゥンシングル",
  pointing: "ロックドキャンディデート",
  claiming: "ロックドキャンディデート",
  "naked-pair": "ネイキッドペア",
  "naked-triple": "ネイキッドトリプル",
  "naked-quad": "ネイキッドクアッド",
  "hidden-pair": "ヒドゥンペア",
  "hidden-triple": "ヒドゥントリプル",
  "x-wing": "X-Wing",
  swordfish: "ソードフィッシュ",
  "xy-wing": "XY-Wing",
  "xyz-wing": "XYZ-Wing",
};

const BOX_NAME = ["左上", "上", "右上", "左", "中央", "右", "左下", "下", "右下"];

/** ユニットの呼び名（例: 3行目、5列目、中央のブロック） */
export function unitName(u: number): string {
  if (u < 9) return `${u + 1}行目`;
  if (u < 18) return `${u - 8}列目`;
  return `${BOX_NAME[u - 18]}のブロック`;
}

const unitKind = (u: number) => (u < 9 ? "行" : u < 18 ? "列" : "ブロック");
const list = (ds: (number | string)[]) => ds.join("・");

function explain(technique: TechniqueId, units: number[], digits: number[], size: number): string {
  const d = digits[0];
  switch (technique) {
    case "naked-single":
      return `このマスに入る数字は ${d} だけです`;
    case "hidden-single":
      return `${unitName(units[0])}で ${d} が入るのはこのマスだけです`;
    case "pointing":
    case "claiming":
      return `${unitName(units[0])}の ${d} は${unitName(units[1])}にしか入りません。${unitName(units[1])}の他のマスから ${d} を消せます`;
    case "naked-pair":
    case "naked-triple":
    case "naked-quad":
      return `${unitName(units[0])}のこの${size}マスには ${list(digits)} しか入りません。同じ${unitKind(units[0])}の他のマスから ${list(digits)} を消せます`;
    case "hidden-pair":
    case "hidden-triple":
      return `${unitName(units[0])}で ${list(digits)} が入るのはこの${size}マスだけです。このマスの他の候補を消せます`;
    case "x-wing":
    case "swordfish": {
      const n = units.length / 2;
      const base = units.slice(0, n);
      const cross = units.slice(n);
      return `${list(base.map(unitName))}の ${d} は、どれも${list(cross.map(unitName))}にしか入りません。${list(cross.map(unitName))}の他のマスから ${d} を消せます`;
    }
    case "xy-wing":
      return `真ん中のマスがどちらの数字でも、両端のどちらかに ${d} が入ります。両端の両方から見えるマスの ${d} を消せます`;
    case "xyz-wing":
      return `3 つのマスのどれかに必ず ${d} が入ります。3 つすべてから見えるマスの ${d} を消せます`;
  }
}

/**
 * 今の盤面からヒントを作る。
 * 候補は盤面の数字から計算し、メモがあるマスは（正解を消していなければ）メモで絞り込む。
 * 間違った数字があれば、まずそれを指す
 */
export function findHint(puzzle: Grid, values: Grid, notes: number[], solution: Grid): Hint | null {
  const wrong = values.findIndex((v, i) => v !== 0 && !puzzle[i] && v !== solution[i]);
  if (wrong !== -1) {
    return {
      kind: "wrong",
      cell: wrong,
      title: "違う数字があります",
      text: "このマスの数字が違います",
      focus: [wrong],
      targets: [wrong],
    };
  }
  if (values.every((v) => v !== 0)) return null;

  const base = candidatesOf(values);
  const cands = base.map((c, i) => {
    const n = notes[i];
    return !values[i] && n && n & (1 << solution[i]) ? c & n : c;
  });

  const step = findNextStep(values, cands);
  if (!step) {
    // 手筋で進めない局面：候補の少ないマスを 1 つ埋める
    let cell = -1;
    let best = 10;
    for (let i = 0; i < 81; i++) {
      if (values[i]) continue;
      const n = cands[i].toString(2).replace(/0/g, "").length;
      if (n < best) {
        best = n;
        cell = i;
      }
    }
    return {
      kind: "guess",
      title: "手筋では進めません",
      text: "ここから先はチェーンや仮定が要ります。1マス埋めます",
      focus: [cell],
      targets: [cell],
      cell,
      digit: solution[cell],
    };
  }

  const { trace, placement, eliminations } = step;
  const title = TECHNIQUE_NAME[trace.technique];
  const text = explain(trace.technique, trace.units, trace.digits, trace.pattern.length);
  // 1 段目で照らす範囲：関係するユニット。ユニットの無い手筋（XY-Wing など）は根拠のマスとその周り
  const focus =
    trace.units.length > 0
      ? [...new Set(trace.units.flatMap((u) => UNITS[u]))]
      : [...new Set(trace.pattern.flatMap((c) => [c, ...PEERS[c]]))];

  if (placement) {
    return {
      kind: "place",
      technique: trace.technique,
      title,
      text,
      focus,
      pattern: trace.pattern,
      targets: [placement.cell],
      cell: placement.cell,
      digit: placement.digit,
    };
  }
  return {
    kind: "eliminate",
    technique: trace.technique,
    title,
    text,
    focus,
    pattern: trace.pattern,
    targets: [...new Set(eliminations.map((e) => e.cell))],
    eliminations,
  };
}

/**
 * ヒントの消去をメモに反映した新しいメモ。メモの無い空きマスには候補をすべて書いてから消す
 */
export function notesAfterHint(
  values: Grid,
  notes: number[],
  eliminations: { cell: number; digit: number }[],
) {
  const base = candidatesOf(values);
  const out = notes.map((n, i) => (values[i] ? 0 : n || base[i]));
  for (const { cell, digit } of eliminations) out[cell] &= ~(1 << digit);
  return out;
}
