import { describe, expect, it } from "vitest";
import { SITE_ORIGIN } from "@/lib/site";
import { DIFFICULTIES, isValidSolution, parseGrid, serializeGrid } from "@/lib/sudoku/core";
import { gradePuzzle } from "@/lib/sudoku/logic";
import { solve } from "@/lib/sudoku/solver";
import {
  MAX_SEARCH,
  checkPuzzle,
  parseShared,
  shareUrl,
  withoutShared,
  type SharedResult,
} from "./sharedPuzzle";

// シングルだけで解ける問題（ヒント 30 個）
const CLASSIC = "530070000600195000098000060800060003400803001700020006060000280000419005000080079";
// ヒント 17 個で解が 1 つの問題
const SEVENTEEN = "000000010400000000020000000000050407008000300001090000300400200050100000000806000";
/** 手筋のレベルごとの問題（generatePuzzle で作ったもの） */
const BY_LEVEL = {
  1: "050000030307900820006070049070020603690107085801000070130080700048000301060000050",
  2: "090630580502008300003070004157000030000080000000000045000040800008700406034051900",
  3: "008200000570080002000063040230000800000109000409000017010752000000010473000000100",
  4: "800600040700000500020340000000001003000020090300500070630870050002000006050006004",
  5: "009700001000605000004000230208004090000000000090800103032000005070109000900050800",
  6: "100006004060000000200000078000800000074000100500302040800000009001000020000760001",
} as const;
// よく知られた難問（Platinum Blonde）。解が 1 つと確かめるのに 11 万回ほど置く
const PLATINUM_BLONDE = "000000012000000003002300400001800005060070800000009000008500000900040500470006000";
/**
 * 確かめ終わるまでに何百万回も置く盤面（打ち切る）。ヒント 17 個の Norvig の hard1、
 * 1 行目に 1 を置けない盤面にヒントを足したもの、ランダムに置いたもの
 */
const EXHAUSTING = [
  "000006000059000008200008000045000000003000000006003054000325006000000000000000000",
  "000000002010000000000010000690500100070000000000001030035020010700000000100000670",
  "306000500700000002000100000007000050000000924000080000001000000005300001000026000",
];

const at = (s: string, i: number, ch: string) => s.slice(0, i) + ch + s.slice(i + 1);
const reason = (r: SharedResult | null) => (r && !r.ok ? r.reason : r);
const read = (search: string) => {
  const r = parseShared(search);
  if (!r?.ok) throw new Error(`読めなかった: ${JSON.stringify(r)}`);
  return r.puzzle;
};

describe("共有された盤面を読む", () => {
  it("p が無ければ読まない", () => {
    for (const search of ["", "?", "?from=e2e", "?d=hard", "?pp=1", "?%70=" + CLASSIC, "?P=" + CLASSIC]) {
      expect(parseShared(search), search).toBeNull();
    }
  });

  it("81 桁の盤面を読み、解答・難易度・シードを付ける", () => {
    const p = read(`?p=${CLASSIC}`);
    expect(serializeGrid(p.puzzle)).toBe(CLASSIC);
    expect(p.solution).toEqual(solve(parseGrid(CLASSIC)));
    expect(isValidSolution(p.puzzle, p.solution)).toBe(true);
    expect(p.difficulty).toBe("easy");
    expect(p.seed).toBe(`shared:${CLASSIC}`);
    // ? の無いクエリ、ほかのパラメータと並んでいても読む
    expect(read(`p=${CLASSIC}`).puzzle).toEqual(p.puzzle);
    expect(read(`?from=x&p=${CLASSIC}&utm=1`).puzzle).toEqual(p.puzzle);
  });

  it("長さが 81 でなければ読めない", () => {
    for (const p of [CLASSIC.slice(0, 80), CLASSIC + "0", "", "123"]) {
      expect(reason(parseShared(`?p=${p}`)), p).toBe("format");
    }
    expect(reason(parseShared("?p"))).toBe("format");
    expect(reason(parseShared(`?p=${CLASSIC}&p=${CLASSIC}`))).toBe("format");
  });

  it("数字以外の文字（全角数字・空白・改行・. ・% エンコード）は読めない。値はデコードしない", () => {
    const bad = [
      at(CLASSIC, 2, "１"),
      at(CLASSIC, 2, "%EF%BC%91"),
      at(CLASSIC, 2, " "),
      at(CLASSIC, 2, "+"),
      at(CLASSIC, 2, "\n"),
      at(CLASSIC, 2, "."),
      at(CLASSIC, 2, "a"),
      at(CLASSIC, 2, "-"),
    ];
    for (const p of bad) expect(reason(parseShared(`?p=${p}`)), JSON.stringify(p)).toBe("format");
    // 長さを合わせても、% エンコードした数字・空白・改行は読めない
    for (const enc of ["%30", "%20", "%0A"]) {
      expect(reason(parseShared(`?p=${enc}${CLASSIC.slice(3)}`)), enc).toBe("format");
      expect(reason(parseShared(`?p=${CLASSIC.slice(0, 78)}${enc}`)), enc).toBe("format");
    }
    expect(reason(parseShared(`?p=${CLASSIC}%0A`))).toBe("format");
    expect(reason(parseShared(`?p=%20${CLASSIC}`))).toBe("format");
  });

  it("同じ行・列・ブロックに同じ数字があれば読めない", () => {
    // 1 行目の 3 マス目に、同じ行の 5 を置く
    expect(reason(parseShared(`?p=${at(CLASSIC, 2, "5")}`))).toBe("conflict");
  });

  it("解が無い・2 つ以上ある盤面は読めない", () => {
    // 1 マス目の 5 を 1 にすると、重複は無いが解が無い
    expect(reason(parseShared(`?p=${at(CLASSIC, 0, "1")}`))).toBe("no-solution");
    // 最初の 2 つのヒントを消すと解が 2 つ以上になる（ヒント 28 個）
    expect(reason(parseShared(`?p=00${CLASSIC.slice(2)}`))).toBe("multiple");
  });

  it("ヒントは 17〜80 個。16 個以下と 81 個（空きマスが無い）は読めない", () => {
    expect([...SEVENTEEN].filter((c) => c !== "0")).toHaveLength(17);
    expect(read(`?p=${SEVENTEEN}`).difficulty).toBe("easy");
    const sixteen = at(SEVENTEEN, SEVENTEEN.indexOf("1"), "0");
    expect(reason(parseShared(`?p=${sixteen}`))).toBe("givens");
    expect(reason(parseShared(`?p=${"0".repeat(81)}`))).toBe("givens");

    const full = serializeGrid(solve(parseGrid(CLASSIC))!);
    expect(reason(parseShared(`?p=${full}`))).toBe("givens");
    const one = read(`?p=${at(full, 40, "0")}`);
    expect(one.puzzle.filter((v) => v === 0)).toHaveLength(1);
    expect(one.difficulty).toBe("easy");
  });

  it("難易度は手筋のレベルで決める（1 かんたん、2 ふつう、3・4 むずかしい、5 エキスパート、6 鬼）", () => {
    const expected = { 1: "easy", 2: "medium", 3: "hard", 4: "hard", 5: "expert", 6: "master" } as const;
    for (const [level, p] of Object.entries(BY_LEVEL)) {
      expect(gradePuzzle(parseGrid(p)), level).toBe(Number(level));
      expect(read(`?p=${p}`).difficulty, level).toBe(expected[Number(level) as keyof typeof expected]);
    }
  });

  it("d は手筋のレベルが合うときだけ使う。極はレベル 6 のとき", () => {
    expect(read(`?p=${BY_LEVEL[6]}&d=extreme`).difficulty).toBe("extreme");
    expect(read(`?d=master&p=${BY_LEVEL[6]}`).difficulty).toBe("master");
    expect(read(`?p=${BY_LEVEL[3]}&d=hard`).difficulty).toBe("hard");
    expect(read(`?p=${BY_LEVEL[4]}&d=hard`).difficulty).toBe("hard");
    // 合わなければ判定のほう
    expect(read(`?p=${BY_LEVEL[1]}&d=extreme`).difficulty).toBe("easy");
    expect(read(`?p=${BY_LEVEL[6]}&d=easy`).difficulty).toBe("master");
    expect(read(`?p=${BY_LEVEL[5]}&d=hard`).difficulty).toBe("expert");
    // 知らない値・エンコードした値・2 つある・空は使わない
    for (const d of ["d=x", "d=Extreme", "d=%65xtreme", "d=extreme&d=extreme", "d=", "d"]) {
      expect(read(`?p=${BY_LEVEL[6]}&${d}`).difficulty, d).toBe("master");
    }
  });

  it("よく知られた難問は読める", () => {
    const p = read(`?p=${PLATINUM_BLONDE}`);
    expect(p.difficulty).toBe("master");
    expect(isValidSolution(p.puzzle, p.solution)).toBe(true);
  });

  it("確かめ終わるまでに時間の掛かる盤面は、打ち切って読めないとする", () => {
    for (const p of EXHAUSTING) {
      const t = performance.now();
      expect(reason(parseShared(`?p=${p}`)), p).toBe("too-hard");
      // 手元（Apple Silicon）では 1 回 100〜220ms。CI の遅い環境や、テストを並べて走らせた負荷でも固まらない
      expect(performance.now() - t, p).toBeLessThan(10_000);
    }
  });

  it("巨大な入力でもすぐに断る", () => {
    const t = performance.now();
    expect(reason(parseShared(`?p=${"1".repeat(2_000_000)}`))).toBe("format");
    expect(reason(parseShared(`?x=${"a&".repeat(1_000_000)}p=${CLASSIC}`))).toBe("format");
    expect(parseShared(`?x=${"a&".repeat(1_000_000)}`)).toBeNull();
    expect(performance.now() - t).toBeLessThan(500);
    // 上限ちょうどまでは読む
    const padded = `?p=${CLASSIC}&x=${"a".repeat(MAX_SEARCH - 87)}`;
    expect(padded).toHaveLength(MAX_SEARCH);
    expect(read(padded).difficulty).toBe("easy");
    expect(reason(parseShared(`${padded}a`))).toBe("format");
  });
});

describe("盤面を確かめる（checkPuzzle）", () => {
  it("長さが 81 でない・0〜9 の整数でない値がある盤面は形が違うとする", () => {
    const g = parseGrid(CLASSIC);
    const bad = [
      g.slice(0, 80),
      [...g, 0],
      [],
      g.map((v, i) => (i === 3 ? 10 : v)),
      g.map((v, i) => (i === 3 ? -1 : v)),
      g.map((v, i) => (i === 3 ? 1.5 : v)),
      g.map((v, i) => (i === 3 ? Number.NaN : v)),
    ];
    for (const grid of bad) expect(reason(checkPuzzle(grid, null)), JSON.stringify(grid)).toBe("format");
    const ok = checkPuzzle(g, null);
    expect(ok.ok && serializeGrid(ok.puzzle.puzzle)).toBe(CLASSIC);
    // 渡した配列は書き換えず、写しを返す
    expect(ok.ok && ok.puzzle.puzzle).not.toBe(g);
  });
});

describe("URL から共有の盤面を消す", () => {
  it("p と d だけを消し、ほかのパラメータは残す。何も残らなければ ? も残さない", () => {
    expect(withoutShared(`?p=${CLASSIC}`)).toBe("");
    expect(withoutShared(`?p=${CLASSIC}&d=hard`)).toBe("");
    expect(withoutShared(`?from=e2e&p=${CLASSIC}&d=hard&x=%20`)).toBe("?from=e2e&x=%20");
    expect(withoutShared("?p=1&p=2&d&&pp=3")).toBe("?pp=3");
  });
});

describe("共有する URL", () => {
  it("本番の URL に、最初の配置と難易度を付ける。読み直すと同じ盤面と難易度になる", () => {
    const puzzles = {
      easy: CLASSIC,
      medium: BY_LEVEL[2],
      hard: BY_LEVEL[4],
      expert: BY_LEVEL[5],
      master: BY_LEVEL[6],
      extreme: BY_LEVEL[6],
    };
    for (const d of DIFFICULTIES) {
      const p = puzzles[d];
      const url = shareUrl({ puzzle: parseGrid(p), difficulty: d });
      expect(url).toBe(`${SITE_ORIGIN}/?p=${p}&d=${d}`);
      const back = read(new URL(url).search);
      expect(serializeGrid(back.puzzle)).toBe(p);
      expect(back.difficulty).toBe(d);
    }
  });
});
