import { describe, expect, it } from "vitest";
import { bitCount } from "./core";
import { findHint, notesAfterHint } from "./hint";
import { candidatesOf, findAllSteps, findNextStep, type NextStep } from "./logic";
import {
  PRACTICE_KEYS,
  answerOf,
  checkPractice,
  practiceItems,
  practiceKeyOf,
  startNotes,
  techniqueRows,
  type PracticePosition,
} from "./practice";
import { PRACTICE_POSITIONS } from "./practice-data";
import { countSolutions, solve } from "./solver";

const items = practiceItems(PRACTICE_POSITIONS);
const positions = items.flatMap((item) => item.positions);
const sortedMoves = (step: Pick<NextStep, "eliminations">) =>
  step.eliminations.map((e) => `${e.cell}-${e.digit}`).sort();

describe("同梱の局面", () => {
  it("項目は易しい順に並び、どれも 3〜5 局面。id は重ならない", () => {
    expect(items.map((item) => item.key)).toEqual(
      PRACTICE_KEYS.filter((k) => items.some((i) => i.key === k)),
    );
    for (const item of items) {
      expect(item.positions.length, item.key).toBeGreaterThanOrEqual(3);
      expect(item.positions.length, item.key).toBeLessThanOrEqual(5);
    }
    expect(positions).toHaveLength(PRACTICE_POSITIONS.length);
    expect(new Set(positions.map((p) => p.id)).size).toBe(positions.length);
  });

  it("盤面は解が 1 つで、解答と食い違わない", () => {
    for (const p of positions) {
      expect(countSolutions(p.values), p.id).toBe(1);
      expect(solve(p.values), p.id).toEqual(p.solution);
    }
  });

  it("取り除く候補は空きマスにある候補で、正解の数字ではない。始めのメモはどの空きマスにも正解を残す", () => {
    for (const p of positions) {
      const base = candidatesOf(p.values);
      const seen = new Set<string>();
      for (const [cell, digit] of p.removed) {
        expect(p.values[cell], p.id).toBe(0);
        expect(base[cell] & (1 << digit), p.id).not.toBe(0);
        expect(digit, p.id).not.toBe(p.solution[cell]);
        seen.add(`${cell}-${digit}`);
      }
      expect(seen.size, p.id).toBe(p.removed.length);
      const notes = startNotes(p);
      for (let i = 0; i < 81; i++) {
        if (p.values[i]) expect(notes[i], p.id).toBe(0);
        else expect(notes[i] & (1 << p.solution[i]), p.id).not.toBe(0);
      }
    }
  });

  it("始めの盤面とメモで、findNextStep は狙いの手筋を最初の一手として返す", () => {
    for (const item of items) {
      for (const p of item.positions) {
        const step = findNextStep(p.values, startNotes(p));
        expect(step?.trace.technique, p.id).toBe(p.technique);
        expect(practiceKeyOf(step!.trace.technique), p.id).toBe(item.key);
        // 消す手筋は消す候補がある
        if (!step!.placement) expect(step!.eliminations.length, p.id).toBeGreaterThan(0);
      }
    }
  });

  it("答えは 1 つ：始めの盤面とメモで、狙いの手筋の手はどれも答えと同じ。置く手筋は、シングルで置けるマスが他に無い", () => {
    // 別の消し方があると、それを見つけて消しても誤りにも正解にもならず、先へ進めない
    const others: string[] = [];
    for (const p of positions) {
      const answer = answerOf(p);
      const all = findAllSteps(p.values, startNotes(p));
      // 先頭は findNextStep の手（答え）。手を集める処理が findNextStep と食い違っていないことも確かめる
      expect(all[0], p.id).toEqual(answer);
      const key = practiceKeyOf(p.technique);
      const want = answer.placement
        ? [`${answer.placement.cell}=${answer.placement.digit}`]
        : sortedMoves(answer);
      for (const step of all) {
        const moves = step.placement
          ? answer.placement && [`${step.placement.cell}=${step.placement.digit}`]
          : !answer.placement && practiceKeyOf(step.trace.technique) === key && sortedMoves(step);
        if (moves && moves.join(" ") !== want.join(" "))
          others.push(`${p.id} ${step.trace.technique} units=${step.trace.units}: ${moves.join(" ")}`);
      }
    }
    expect(others).toEqual([]);
  });

  it("ヒントは同じ手筋で同じマス・候補を指し、適用すると正解になる", () => {
    for (const p of positions) {
      const notes = startNotes(p);
      const answer = answerOf(p);
      const hint = findHint(p.values, p.values, notes, p.solution);
      if (answer.placement) {
        expect(hint, p.id).toMatchObject({ kind: "place", technique: p.technique, ...answer.placement });
        const values = p.values.slice();
        values[answer.placement.cell] = answer.placement.digit;
        expect(checkPractice(p, answer, values, notes).correct, p.id).toBe(true);
      } else {
        expect(hint?.kind, p.id).toBe("eliminate");
        if (hint?.kind !== "eliminate") continue;
        expect(hint.technique, p.id).toBe(p.technique);
        expect(sortedMoves(hint), p.id).toEqual(sortedMoves(answer));
        expect(new Set(hint.targets), p.id).toEqual(new Set(answer.eliminations.map((e) => e.cell)));
        const after = notesAfterHint(p.values, notes, hint.eliminations);
        expect(checkPractice(p, answer, p.values, after).correct, p.id).toBe(true);
      }
    }
  });
});

describe("練習の答え合わせ", () => {
  const first = (place: boolean) => positions.find((p) => !!answerOf(p).placement === place)!;
  /** 局面の空きマスで、狙いのマス以外のもの */
  const otherEmpty = (p: PracticePosition, not: number[]) =>
    p.values.findIndex((v, i) => !v && !not.includes(i));

  it("置く手筋：狙いのマスに正しい数字を置けば正解。違う数字は誤り。他のマスに正しい数字を置いてもまだ正解ではない", () => {
    const p = first(true);
    const answer = answerOf(p);
    const { cell, digit } = answer.placement!;
    const notes = startNotes(p);
    expect(checkPractice(p, answer, p.values, notes)).toEqual({ correct: false, wrong: [], lost: [] });

    const placed = p.values.slice();
    placed[cell] = digit;
    expect(checkPractice(p, answer, placed, notes)).toEqual({ correct: true, wrong: [], lost: [] });

    const wrong = p.values.slice();
    wrong[cell] = (digit % 9) + 1;
    expect(checkPractice(p, answer, wrong, notes)).toEqual({ correct: false, wrong: [cell], lost: [] });

    const other = otherEmpty(p, [cell]);
    const elsewhere = p.values.slice();
    elsewhere[other] = p.solution[other];
    expect(checkPractice(p, answer, elsewhere, notes).correct).toBe(false);
    // 狙いのマスは正しくても、他に違う数字があれば正解にしない
    const both = placed.slice();
    both[other] = (p.solution[other] % 9) + 1;
    expect(checkPractice(p, answer, both, notes)).toEqual({ correct: false, wrong: [other], lost: [] });
  });

  it("消す手筋：消すべき候補をすべて消せば正解。一部だけではまだ。余計な候補を消しても、正解の数字を消さなければ正解", () => {
    const p = first(false);
    const answer = answerOf(p);
    const start = startNotes(p);
    const without = (notes: number[], moves: { cell: number; digit: number }[]) => {
      const out = notes.slice();
      for (const { cell, digit } of moves) out[cell] &= ~(1 << digit);
      return out;
    };
    const all = without(start, answer.eliminations);
    expect(checkPractice(p, answer, p.values, all)).toEqual({ correct: true, wrong: [], lost: [] });
    expect(checkPractice(p, answer, p.values, without(start, answer.eliminations.slice(1))).correct).toBe(
      false,
    );

    // 狙いではない、正解でもない候補を消す（消しすぎ）
    const extra = start.findIndex(
      (n, i) =>
        n &&
        (n & ~(1 << p.solution[i])) !== 0 &&
        !answer.eliminations.some((e) => e.cell === i) &&
        !p.removed.some(([c]) => c === i),
    );
    const extraDigit = [1, 2, 3, 4, 5, 6, 7, 8, 9].find(
      (d) => d !== p.solution[extra] && start[extra] & (1 << d),
    )!;
    expect(
      checkPractice(p, answer, p.values, without(all, [{ cell: extra, digit: extraDigit }])).correct,
    ).toBe(true);

    // 正解の数字を消すと誤り
    const cell = answer.eliminations[0].cell;
    const lost = without(all, [{ cell, digit: p.solution[cell] }]);
    expect(checkPractice(p, answer, p.values, lost)).toEqual({ correct: false, wrong: [], lost: [cell] });
  });

  it("狙いの手でないヒントを反映しても正解にしない（正解の数字をメモから消したまま反映する、消しすぎて見つかった易しい手筋を反映する）", () => {
    const p = first(false);
    const answer = answerOf(p);
    const start = startNotes(p);
    // 狙いと関係なく、始めのメモが候補をすべて書いたまま（2 つ以上）のマス
    const other = start.findIndex(
      (n, i) =>
        bitCount(n) >= 2 &&
        !answer.eliminations.some((e) => e.cell === i) &&
        !p.removed.some(([c]) => c === i),
    );
    expect(other).toBeGreaterThanOrEqual(0);

    // 正解の数字をメモから消してからヒントを反映しても、消した数字は戻らない
    const lostNotes = start.slice();
    lostNotes[other] &= ~(1 << p.solution[other]);
    const hint = findHint(p.values, p.values, lostNotes, p.solution);
    expect(hint?.kind).toBe("eliminate");
    if (hint?.kind !== "eliminate") return;
    expect(sortedMoves(hint)).toEqual(sortedMoves(answer));
    const after = notesAfterHint(p.values, lostNotes, hint.eliminations);
    expect(checkPractice(p, answer, p.values, after)).toEqual({ correct: false, wrong: [], lost: [other] });

    // メモを正解の数字だけにすると、ヒントはそのマスに置くシングルになる。置いても狙いの手筋はまだ
    const single = start.slice();
    single[other] = 1 << p.solution[other];
    expect(findHint(p.values, p.values, single, p.solution)).toMatchObject({
      kind: "place",
      cell: other,
      digit: p.solution[other],
    });
    const placed = p.values.slice();
    placed[other] = p.solution[other];
    expect(checkPractice(p, answer, placed, single)).toEqual({ correct: false, wrong: [], lost: [] });
  });

  it("メモを空にしたマスはメモが無いものとして扱い、誤りにも消したことにもしない。正しい数字を置いたマスは消したことにする", () => {
    const p = first(false);
    const answer = answerOf(p);
    const notes = startNotes(p);
    for (const { cell, digit } of answer.eliminations) notes[cell] &= ~(1 << digit);
    const cell = answer.eliminations[0].cell;
    const cleared = notes.slice();
    cleared[cell] = 0;
    expect(checkPractice(p, answer, p.values, cleared)).toEqual({ correct: false, wrong: [], lost: [] });

    const values = p.values.slice();
    values[cell] = p.solution[cell];
    expect(checkPractice(p, answer, values, cleared).correct).toBe(true);
  });
});

describe("手筋の内訳の表示", () => {
  it("ポインティングとクレーミングを 1 つにまとめ、練習の項目の順に並べる。0 回の手筋は出さない", () => {
    expect(
      techniqueRows({ swordfish: 1, claiming: 2, "hidden-single": 5, pointing: 3, "naked-pair": 0 }),
    ).toEqual([
      { key: "hidden-single", name: "ヒドゥンシングル", count: 5 },
      { key: "pointing", name: "ロックドキャンディデート", count: 5 },
      { key: "swordfish", name: "ソードフィッシュ", count: 1 },
    ]);
    expect(techniqueRows({ claiming: 1 })).toEqual([
      { key: "pointing", name: "ロックドキャンディデート", count: 1 },
    ]);
    expect(techniqueRows({})).toEqual([]);
  });
});
