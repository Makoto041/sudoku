import { createECDH, randomUUID } from "node:crypto";
import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";
import { LEGACY_HOST, SITE_ORIGIN } from "../src/lib/site";
import { digitsOf } from "../src/lib/sudoku/core";
import { answerOf, practiceItems, startNotes, type PracticeItem } from "../src/lib/sudoku/practice";
import { PRACTICE_POSITIONS } from "../src/lib/sudoku/practice-data";
import { solve } from "../src/lib/sudoku/solver";

// ページ内で例外が出たら失敗にする（効果音や触覚の処理も含む）
let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

const SHOTS = process.env.E2E_SHOTS;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` });
}

/** iPhone（WebKit の iPhone 15）のプロジェクトか */
const isIphone = (info: TestInfo) => /iPhone/.test(info.project.use.userAgent ?? "");

type Saved = {
  puzzle: number[];
  solution: number[] | null;
  values: number[];
  notes: number[];
  history: unknown[];
  moves?: unknown[];
  colors?: number[];
};

async function savedGame(page: Page, key: string): Promise<Saved> {
  const raw = await page.evaluate((k) => localStorage.getItem(k), key);
  return JSON.parse(raw!);
}

/** 空きマスを順に選んで数字を入れる。last を残しておき、最後の 1 マスは呼び出し側で入れる */
async function fill(page: Page, puzzle: number[], solution: number[], leaveLast = false) {
  const empties = puzzle.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  const cells = page.getByRole("gridcell");
  const todo = leaveLast ? empties.slice(0, -1) : empties;
  for (const i of todo) {
    await cells.nth(i).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Digit${solution[i]}`);
  }
  return empties[empties.length - 1];
}

/** 記録画面のカード（card）の表で、見出しが label の行の値 */
function metric(page: Page, card: string, label: string) {
  return page
    .getByRole("region", { name: card, exact: true })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) })
    .getByRole("cell");
}

test("フリープレイを最後まで解け、記録画面の始めた数・クリア数・クリア率が増える", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await shot(page, "home");

  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cells = page.getByRole("gridcell");
  const first = g.puzzle.indexOf(0);
  await cells.nth(first).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  // メモを付けてから、間違い → 正解の順に入れる
  await page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ }).click();
  for (const d of [1, 2, 5]) await page.keyboard.press(`Digit${d}`);
  await page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ }).click();
  const wrong = (g.solution![first] % 9) + 1;
  await page.keyboard.press(`Digit${wrong}`);
  await expect(cells.nth(first)).toHaveClass(/wrong/);
  await shot(page, "game-free");
  await page.keyboard.press(`Digit${g.solution![first]}`);

  await fill(
    page,
    g.puzzle.map((v, i) => (i === first ? 1 : v)),
    g.solution!,
  );
  await expect(page.getByRole("dialog", { name: "クリア" })).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "クリア" }).getByRole("heading", { name: "要る手筋", exact: true }),
  ).toBeVisible();
  // 最後に置いた数字と、解き終えたことを読み上げ欄で知らせる
  await expect(boardLive(page)).toHaveText(/に \d クリア$/);
  await page.waitForTimeout(700);
  await shot(page, "result-free");

  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expect(metric(page, "フリープレイ", "始めた数")).toHaveText("1");
  await expect(metric(page, "フリープレイ", "クリア数")).toHaveText("1");
  await expect(metric(page, "フリープレイ", "クリア率")).toHaveText("100%");
  await expect(metric(page, "フリープレイ", "平均時間")).toHaveText(/^\d{2}:\d{2}$/);
  await expect(metric(page, "フリープレイ", "最速")).toHaveText(/^\d{2}:\d{2}$/);
  // 途中で間違えたので、ノーミス最速は無い
  await expect(metric(page, "フリープレイ", "ノーミス最速")).toHaveText("-");
});

test("途中のフリープレイを上書きして始めると、開始数と途中でやめた時間を記録する", async ({ page }) => {
  await page.goto("/");
  await page.locator(".free-easy").click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const first = g.puzzle.indexOf(0);
  await page
    .getByRole("gridcell")
    .nth(first)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${g.solution![first]}`);
  // 1 秒以上たってからホームに戻り、別の難易度を新しく始める
  await expect(page.getByLabel("経過時間")).not.toHaveText("00:00");
  await page.getByRole("button", { name: "ホームに戻る" }).click();
  await page.locator(".free-hard").click();
  await page.getByRole("button", { name: "新しく始める" }).click();
  await expect(page.locator(".bar-main")).toHaveText("むずかしい", { timeout: 10_000 });

  const stats = JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:stats")))!);
  expect(stats.easy.started).toBe(1);
  expect(stats.easy.abandonedMs).toBeGreaterThanOrEqual(1000);
  expect(stats.hard.started).toBe(1);
  expect(stats.hard.abandonedMs).toBeUndefined();

  await page.getByRole("button", { name: "ホームに戻る" }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expect(metric(page, "フリープレイ", "始めた数")).toHaveText("1");
  await expect(metric(page, "フリープレイ", "クリア数")).toHaveText("0");
  await expect(metric(page, "フリープレイ", "クリア率")).toHaveText("0%");
});

test("問題を作っている間に「次の問題へ」や難易度を続けて押しても、始めた数は 1 つしか増えない", async ({
  page,
}) => {
  // ボタンが押せなくなるのは描き直した後なので、その前に 2 回押す
  const pressTwice = (button: Locator) =>
    button.evaluate((b: HTMLElement) => {
      b.click();
      b.click();
    });
  const started = async () =>
    JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:stats")))!).easy.started;
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  const freeEasy = page.getByRole("button", { name: /かんたん/ }).last();

  await page.goto("/");
  await freeEasy.click();
  await expect(board).toBeVisible();
  expect(await started()).toBe(1);
  const g = await savedGame(page, "sudoku:free");
  await fill(page, g.puzzle, g.solution!);
  const result = page.getByRole("dialog", { name: "クリア" });
  await pressTwice(result.getByRole("button", { name: "次の問題へ" }));
  await expect(result).toBeHidden();
  await expect(board).toBeVisible();
  // 記録画面まで行く間に、2 回目の問題作りが走っていれば終わる
  await page.getByRole("button", { name: "ホームに戻る" }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expect(metric(page, "フリープレイ", "始めた数")).toHaveText("2");
  expect(await started()).toBe(2);

  // ホームの難易度のボタンも同じ（途中の問題はまだ 1 手も進めていないので、確認なしで始まる）
  await page.getByRole("button", { name: "戻る", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await pressTwice(freeEasy);
  await expect(board).toBeVisible();
  await page.getByRole("button", { name: "ホームに戻る" }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expect(metric(page, "フリープレイ", "始めた数")).toHaveText("3");
  expect(await started()).toBe(3);
});

test("記録画面で難易度を切り替えると、その難易度の記録が出る", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "sudoku:stats",
      JSON.stringify({
        easy: {
          played: 3,
          bestMs: 95_000,
          cleanBestMs: 100_000,
          bestPoints: 4321,
          started: 4,
          trackedClears: 2,
          totalMs: 250_000,
          abandonedMs: 50_000,
        },
        // 開始数を数える前のクリアだけ
        hard: { played: 2, bestMs: 400_000, cleanBestMs: null, bestPoints: 9000 },
      }),
    );
    for (const [date, timeMs, points] of [
      ["2026-10-01", 600_000, 5000],
      ["2026-10-02", 1_200_000, 7001],
    ] as const) {
      localStorage.setItem(
        `sudoku:result:${date}:hard`,
        JSON.stringify({ date, difficulty: "hard", timeMs, points, rank: 1, total: 1 }),
      );
    }
  });
  await page.goto("/");
  await page.getByRole("button", { name: "記録" }).click();
  const free = (label: string) => metric(page, "フリープレイ", label);
  const daily = (label: string) => metric(page, "今日の一問", label);

  await expect(page.getByRole("tab", { name: "かんたん" })).toHaveAttribute("aria-selected", "true");
  await expect(free("始めた数")).toHaveText("4");
  await expect(free("クリア数")).toHaveText("3");
  await expect(free("クリア率")).toHaveText("50%");
  await expect(free("平均時間")).toHaveText("02:05");
  await expect(free("最速")).toHaveText("01:35");
  await expect(free("ノーミス最速")).toHaveText("01:40");
  await expect(free("最高点")).toHaveText("4,321");
  await expect(daily("クリア数")).toHaveText("0");
  await expect(daily("平均時間")).toHaveText("-");
  // フリープレイ 250 秒 + 50 秒、今日の一問 10 分 + 20 分
  await expect(metric(page, "全体", "合計プレイ時間")).toHaveText("35分");
  await shot(page, "records-stats");

  await page.getByRole("tab", { name: "むずかしい" }).click();
  await expect(page.getByRole("tab", { name: "むずかしい" })).toHaveAttribute("aria-selected", "true");
  await expect(free("始めた数")).toHaveText("-");
  await expect(free("クリア数")).toHaveText("2");
  await expect(free("クリア率")).toHaveText("-");
  await expect(free("平均時間")).toHaveText("-");
  await expect(free("最速")).toHaveText("06:40");
  await expect(free("ノーミス最速")).toHaveText("-");
  await expect(free("最高点")).toHaveText("9,000");
  await expect(daily("クリア数")).toHaveText("2");
  await expect(daily("平均時間")).toHaveText("15:00");
  await expect(daily("最速")).toHaveText("10:00");
  await expect(daily("最高点")).toHaveText("7,001");
  await expect(daily("平均点")).toHaveText("6,001");
  await expect(metric(page, "全体", "合計プレイ時間")).toHaveText("35分");
});

test("今日の一問を解くとランキングに載る", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.locator(".daily-row").first().click();
  // 名前の入力欄は画面の上半分に出す（iPhone のキーボードで隠れないように）
  const nameInput = page.getByPlaceholder("ニックネーム");
  const box = await nameInput.boundingBox();
  expect(box!.y + box!.height).toBeLessThan(page.viewportSize()!.height / 2);
  await nameInput.fill(`テスト${test.info().project.name}`);
  await shot(page, "name-sheet");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();

  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  await expect(page.getByRole("button", { name: "ヒント" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "自動メモ" })).toHaveCount(0);
  // 解答はサーバーから受け取らず、端末で解いたものを持つ
  const solution = solve(g.puzzle)!;
  expect(g.solution).toEqual(solution);
  const last = await fill(page, g.puzzle, solution, true);
  await shot(page, "game-daily");
  // サーバーは 15 秒未満のクリアを受け付けない
  await page.waitForTimeout(15_500);
  await page
    .getByRole("gridcell")
    .nth(last)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${solution[last]}`);
  await expect(page.getByRole("dialog", { name: "クリア" })).toBeVisible();
  await expect(page.getByText(/位/).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "result-daily");

  await page.getByRole("button", { name: "ランキングを見る" }).click();
  await expect(page.locator(".row.is-me")).toBeVisible();
  await shot(page, "ranking");
});

test("鬼の問題を作って遊び始められる", async ({ page }) => {
  await page.goto("/");
  await page.locator(".free-master").click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".bar-main")).toHaveText("鬼");
  const g = await savedGame(page, "sudoku:free");
  expect(g.puzzle.filter((v) => v !== 0).length).toBeLessThanOrEqual(28);
});

test("シートの背景をタップしても、下のボタンが押されない", async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, "タッチ端末だけで起きる");
  await page.addInitScript(() =>
    localStorage.setItem("sudoku:player", JSON.stringify({ id: crypto.randomUUID(), name: "背景" })),
  );
  // 設定シートは上寄せで縦に長い。画面の高さ（92dvh）で切れ、その下に背景が帯状に残る高さにする
  await page.setViewportSize({ width: 393, height: 700 });
  await page.goto("/");
  let started = false;
  page.on("request", (r) => {
    if (r.url().includes("/api/daily/start")) started = true;
  });
  await page.getByRole("button", { name: "設定" }).click();
  const sheet = page.getByRole("dialog", { name: "設定" });
  await expect(sheet).toBeVisible();
  // シートは上から下りてくる。動いている途中に測ったり叩いたりすると位置がずれるので、止まるのを待つ
  await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  // 背景の帯の中央にボタンが来るよう、下のページをスクロールする。ボタンの位置はフォントで変わるので、
  // ページの下端まで送っても届かないときは、画面を低くして帯を上げてから測り直す
  let target: { x: number; y: number; band: number } | null = null;
  for (let height = 700; !target && height >= 480; height -= 20) {
    await page.setViewportSize({ width: 393, height });
    target = await sheet.locator(".sheet").evaluate((sheetEl) => {
      const top = sheetEl.getBoundingClientRect().bottom;
      const y = (top + window.innerHeight) / 2;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      for (const el of document.querySelectorAll(".daily-row, .free-btn")) {
        const r = el.getBoundingClientRect();
        const scroll = window.scrollY + r.top + r.height / 2 - y;
        if (scroll < 0 || scroll > max) continue;
        window.scrollTo({ top: scroll, behavior: "instant" });
        const after = el.getBoundingClientRect();
        return { x: after.left + after.width / 2, y, band: window.innerHeight - top };
      }
      return null;
    });
  }
  expect(target, "背景の帯に重ねられるボタンがない").not.toBeNull();
  expect(target!.band, "シートの下に背景がほとんど残っていない").toBeGreaterThan(24);
  // 叩く位置のいちばん上が背景そのもので、その下にボタンがあること
  const stack = await page.evaluate(({ x, y }) => {
    const [front, ...behind] = document.elementsFromPoint(x, y);
    return {
      backdrop: front.matches(".sheet-backdrop"),
      button: behind.some((el) => el.matches(".daily-row, .free-btn")),
    };
  }, target!);
  expect(stack).toEqual({ backdrop: true, button: true });
  // 下のボタンに click が届いたかを記録する（鬼・極は盤面が出るまで時間がかかり、盤面の有無では分からない）
  await page.evaluate(() => {
    const w = window as unknown as { pressed: boolean };
    w.pressed = false;
    window.addEventListener(
      "click",
      (e) => {
        if ((e.target as Element).closest(".daily-row, .free-btn")) w.pressed = true;
      },
      true,
    );
  });
  await page.touchscreen.tap(target!.x, target!.y);
  await expect(sheet).toBeHidden();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as { pressed: boolean }).pressed)).toBe(false);
  expect(started).toBe(false);
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await expect(page.getByRole("grid")).toHaveCount(0);
});

test("間違えたマスに正しい数字を入れ直すと揺れない", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cell = g.puzzle.indexOf(0);
  const cells = page.getByRole("gridcell");
  await cells.nth(cell).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${(g.solution![cell] % 9) + 1}`);
  await expect(cells.nth(cell).locator(".digit")).toHaveClass(/shake/);
  await page.keyboard.press("Backspace");
  await page.keyboard.press(`Digit${g.solution![cell]}`);
  await expect(cells.nth(cell).locator(".digit")).not.toHaveClass(/shake/);
});

test("端末の日付がずれていても、今日の一問の続きが消えない", async ({ page }, info) => {
  // 端末の時計だけ日本時間の前日 22:00 にする（サーバーは実際の時刻）
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  await page.clock.setFixedTime(
    new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - 1, 22 - 9)),
  );
  await page.goto("/");
  await page.locator(".daily-row").first().click();
  await page.getByPlaceholder("ニックネーム").fill(`日付${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  await page.getByRole("gridcell").nth(g.puzzle.indexOf(0)).dispatchEvent("pointerdown", {
    pointerType: "touch",
    button: 0,
  });
  await page.keyboard.press("Digit5");
  await page.getByRole("button", { name: "ホームに戻る" }).click();
  await expect(page.locator(".daily-row").first()).toContainText("続ける");
  await page.locator(".daily-row").first().click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const after = await savedGame(page, key);
  expect(after.values[g.puzzle.indexOf(0)]).toBe(5);
});

test("行き詰まったら知らせ、間違える前まで戻せる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  // 空きマス c の周りに、c に入れられる数字をすべて置いて c を埋められなくする
  const c = g.puzzle.indexOf(0);
  const peers = (i: number) =>
    Array.from({ length: 81 }, (_, j) => j).filter(
      (j) =>
        j !== i &&
        (Math.floor(j / 9) === Math.floor(i / 9) ||
          j % 9 === i % 9 ||
          (Math.floor(j / 27) === Math.floor(i / 27) && Math.floor((j % 9) / 3) === Math.floor((i % 9) / 3))),
    );
  const used = new Set(peers(c).map((j) => g.puzzle[j]));
  const free = peers(c).filter((j) => g.puzzle[j] === 0);
  const cells = page.getByRole("gridcell");
  for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !used.has(d))) {
    const j = free.shift()!;
    await cells.nth(j).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Digit${d}`);
  }
  await expect(page.getByText("どこかで間違えています")).toBeVisible();
  await expect(cells.nth(c)).toHaveClass(/stuck/);
  await page.waitForTimeout(400);
  await shot(page, "stuck");
  await page.getByRole("button", { name: "間違える前まで戻す" }).click();
  await expect(page.getByText("どこかで間違えています")).toBeHidden();
  await expect(cells.nth(c)).not.toHaveClass(/stuck/);
});

test("今日の一問でも、重複しない間違いを赤く表示する", async ({ page }, info) => {
  await page.goto("/");
  await page.locator(".daily-row").nth(2).click();
  await page.getByPlaceholder("ニックネーム").fill(`赤${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  const solution = solve(g.puzzle)!;
  // 同じ行・列・ブロックに無い数字のうち、解答ではないものを入れる
  const peersOf = (i: number) =>
    g.puzzle.filter(
      (_, j) =>
        j !== i &&
        (Math.floor(j / 9) === Math.floor(i / 9) ||
          j % 9 === i % 9 ||
          (Math.floor(j / 27) === Math.floor(i / 27) && Math.floor((j % 9) / 3) === Math.floor((i % 9) / 3))),
    );
  let cell = -1;
  let digit = 0;
  for (let i = 0; i < 81 && cell < 0; i++) {
    if (g.puzzle[i]) continue;
    const used = new Set(peersOf(i));
    const d = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((d) => !used.has(d) && d !== solution[i]);
    if (d) [cell, digit] = [i, d];
  }
  const target = page.getByRole("gridcell").nth(cell);
  await target.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${digit}`);
  await expect(target).toHaveClass(/wrong/);
  await expect(page.locator(".stat-pair .stat-value")).toHaveText("1");
});

test("置く音の録音を配信している", async ({ request }) => {
  const res = await request.get("/sounds/clack.mp3");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("audio/mpeg");
  expect((await res.body()).length).toBeGreaterThan(1000);
});

test("CSP を付けて配り、ホーム・フリープレイ・設定・記録・遊び方・練習で CSP の違反が出ない", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.exposeFunction("__cspViolation", (v: string) => violations.push(v));
  await page.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    ),
  );
  const res = await page.goto("/");
  expect(res!.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(res!.headers()["content-security-policy"]).not.toContain("'unsafe-eval'");
  expect(res!.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();

  await page.locator(".free-easy").click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const first = g.puzzle.indexOf(0);
  await page
    .getByRole("gridcell")
    .nth(first)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${g.solution![first]}`);
  // 置く音の録音は最初の入力で fetch で読む（connect-src）。Service Worker が返した分も Resource Timing に残る
  await expect
    .poll(() =>
      page.evaluate(
        () => performance.getEntriesByName(new URL("/sounds/clack.mp3", location.href).href).length,
      ),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "ホームに戻る" }).click();

  await page.getByRole("banner").getByRole("button", { name: "設定" }).click();
  await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "設定" })).toBeHidden();
  await page.getByRole("banner").getByRole("button", { name: "記録" }).click();
  await expect(metric(page, "フリープレイ", "始めた数")).toHaveText("1");
  await page.goBack();
  await howtoButton(page).click();
  await page.getByRole("dialog", { name: "遊び方" }).getByRole("button", { name: "練習してみる" }).click();
  await expect(page.getByRole("heading", { name: practiceItem("naked-single").name })).toBeVisible();
  await page.goBack();
  await expect(page.locator(".practice-row").first()).toBeVisible();
  expect(violations).toEqual([]);
});

test("正しく置くと得点が浮かび、スコアが増える。間違えると減る", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /ふつう/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const empties = g.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const cells = page.getByRole("gridcell");
  const score = page.locator(".score-value");
  await expect(score).toHaveText("0");
  await cells.nth(empties[0]).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${g.solution![empties[0]]}`);
  await expect(page.locator(".popup.gain")).toHaveText(/^\+\d+$/);
  const after = Number((await score.textContent())!.replace(/,/g, ""));
  expect(after).toBeGreaterThan(0);
  await cells.nth(empties[1]).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${(g.solution![empties[1]] % 9) + 1}`);
  await expect(page.locator(".popup.loss")).toBeVisible();
  expect(Number((await score.textContent())!.replace(/,/g, ""))).toBeLessThan(after);
  await shot(page, "score");
});

test("極の問題を作って遊び始められる", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await page.locator(".free-extreme").click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".bar-main")).toHaveText("極");
});

test("今日の一問を解くと連続日数が付き、記録画面のカレンダーに残る", async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.locator(".daily-row").first().click();
  await page.getByPlaceholder("ニックネーム").fill(`記録${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  const solution = solve(g.puzzle)!;
  const last = await fill(page, g.puzzle, solution, true);
  await page.waitForTimeout(15_500);
  await page
    .getByRole("gridcell")
    .nth(last)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${solution[last]}`);
  await expect(page.getByText(/位/).first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "ホーム", exact: true }).click();
  await expect(page.locator(".streak-chip")).toHaveText("1日連続");
  await page.getByRole("button", { name: "記録" }).click();
  await expect(page.locator(".streak-num")).toHaveText("1");
  await expect(page.locator(".cal-day.is-played")).toHaveCount(1);
  await expect(metric(page, "今日の一問", "クリア数")).toHaveText("1");
  await shot(page, "records");
});

test("引き継ぎコードで別の端末に同じプレイヤーとフリープレイの記録を移せる", async ({ browser }) => {
  const stats = {
    easy: {
      played: 2,
      bestMs: 95_000,
      cleanBestMs: null,
      bestPoints: 1200,
      started: 3,
      trackedClears: 2,
      totalMs: 200_000,
      abandonedMs: 30_000,
    },
  };
  const a = await browser.newContext();
  const pa = await a.newPage();
  await pa.addInitScript((s) => {
    localStorage.setItem(
      "sudoku:player",
      JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", name: "引き継ぎ元" }),
    );
    localStorage.setItem("sudoku:stats", s);
  }, JSON.stringify(stats));
  await pa.goto("/");
  await pa.getByRole("button", { name: "設定" }).click();
  await pa.getByRole("button", { name: "コードを発行" }).click();
  const code = (await pa.locator(".transfer-code .code").textContent())!;
  expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await a.close();

  const b = await browser.newContext();
  const pb = await b.newPage();
  await pb.goto("/");
  await pb.getByRole("button", { name: "設定" }).click();
  await pb.getByRole("button", { name: "コードを入力" }).click();
  await pb.getByLabel("引き継ぎコード").fill(code.toLowerCase());
  await pb.getByRole("button", { name: "引き継ぐ" }).click();
  await expect(pb.getByText("引き継ぎました")).toBeVisible();
  const player = JSON.parse((await pb.evaluate(() => localStorage.getItem("sudoku:player")))!);
  expect(player).toEqual({ id: "33333333-3333-4333-8333-333333333333", name: "引き継ぎ元" });
  await expect(pb.getByText("引き継ぎ元")).toBeVisible();
  expect(JSON.parse((await pb.evaluate(() => localStorage.getItem("sudoku:stats")))!)).toEqual(stats);
  await b.close();
});

test("記録の保存データに余計な項目が残る端末でも、検証した記録だけを送って引き継ぎコードを発行できる", async ({
  page,
}) => {
  // 旧版や手で書き換えた保存データ。そのまま送るとサーバーの上限（4096 バイト）を超える
  const dirty = {
    easy: {
      played: 2.9,
      bestMs: 95_000.5,
      cleanBestMs: "x",
      bestPoints: 1200.4,
      started: 3.5,
      trackedClears: 2,
      totalMs: 200_000,
      old: "x".repeat(5000),
    },
    junk: { played: 9 },
  };
  expect(JSON.stringify(dirty).length).toBeGreaterThan(4096);
  await page.addInitScript((s) => {
    localStorage.setItem(
      "sudoku:player",
      JSON.stringify({ id: "44444444-4444-4444-8444-444444444444", name: "汚れた端末" }),
    );
    localStorage.setItem("sudoku:stats", s);
  }, JSON.stringify(dirty));
  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();
  const [res] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/api/player/transfer"),
    page.getByRole("button", { name: "コードを発行" }).click(),
  ]);
  // 知らない項目と難易度でないキーを捨て、回数は整数、最高点は四捨五入、時間はそのまま
  expect(res.request().postDataJSON().stats).toEqual({
    easy: {
      played: 2,
      bestMs: 95_000.5,
      cleanBestMs: null,
      bestPoints: 1200,
      started: 3,
      trackedClears: 2,
      totalMs: 200_000,
    },
  });
  expect(res.status()).toBe(200);
  await expect(page.locator(".transfer-code .code")).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
});

test("ヒントは手筋の名前→説明の順に出し、置くかメモに反映できる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /ふつう/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const before = await savedGame(page, "sudoku:free");
  await page.getByRole("button", { name: "ヒント" }).click();
  const panel = page.locator(".hint-panel");
  await expect(panel.locator(".hint-title")).toHaveText(
    /シングル|ロックド|ペア|トリプル|クアッド|Wing|ソード/,
  );
  await expect(panel.locator(".hint-body")).toHaveCount(0);
  await expect(page.locator(".cell.hint-focus").first()).toBeVisible();
  await panel.getByRole("button", { name: "もっと見る" }).click();
  await expect(panel.locator(".hint-body")).toBeVisible();
  await expect(page.locator(".cell.hint-target").first()).toBeVisible();
  await shot(page, "hint");
  const action = panel.getByRole("button", { name: /置く|メモに反映/ });
  const label = await action.textContent();
  await action.click();
  await expect(panel).toBeHidden();
  await page.waitForTimeout(300);
  const after = await savedGame(page, "sudoku:free");
  if (label === "置く") {
    const placed = after.values.findIndex((v, i) => v !== before.values[i]);
    expect(placed).toBeGreaterThanOrEqual(0);
    expect(after.values[placed]).toBe(before.solution![placed]);
  } else {
    expect((after as unknown as { notes: number[] }).notes.some((n) => n !== 0)).toBe(true);
  }
  await expect(page.locator(".tool-count")).toHaveText("1");
});

test("違う数字があると、ヒントはそのマスを指して消せる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cell = g.puzzle.indexOf(0);
  await page
    .getByRole("gridcell")
    .nth(cell)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${(g.solution![cell] % 9) + 1}`);
  await page.getByRole("button", { name: "ヒント" }).click();
  await expect(page.locator(".hint-title")).toHaveText("違う数字があります");
  await expect(page.getByRole("gridcell").nth(cell)).toHaveClass(/hint-target/);
  await page.locator(".hint-panel").getByRole("button", { name: "消す" }).click();
  await expect(page.getByRole("gridcell").nth(cell)).not.toHaveClass(/filled|wrong/);
});

test("自動メモで候補をすべて書き、もう一度で消す。今日の一問には出ない", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  await page.getByRole("button", { name: "自動メモ" }).click();
  const g = await savedGame(page, "sudoku:free");
  const empties = g.puzzle.filter((v) => v === 0).length;
  await expect(page.locator(".cell .notes")).toHaveCount(empties);
  await page.getByRole("button", { name: "自動メモ" }).click();
  await expect(page.locator(".cell .notes")).toHaveCount(0);
});

test("設定で行・列・ブロックの強調と残りの数を消せる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cells = page.getByRole("gridcell");
  // 空きの最も少ない数字を使い切り、薄い表示が出る状態にする
  const empties = (d: number) => g.puzzle.flatMap((v, i) => (!v && g.solution![i] === d ? [i] : []));
  const digit = [1, 2, 3, 4, 5, 6, 7, 8, 9].sort((a, b) => empties(a).length - empties(b).length)[0];
  for (const i of empties(digit)) {
    await cells.nth(i).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Digit${digit}`);
  }
  await cells.nth(g.puzzle.indexOf(0)).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await expect(page.locator(".cell.peer")).toHaveCount(20);
  await expect(page.locator(".pad-key.is-done").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /残り/ })).toHaveCount(9);

  await page.getByRole("button", { name: "設定" }).click();
  const sheet = page.getByRole("dialog", { name: "設定" });
  await sheet.getByRole("checkbox", { name: "行・列・ブロックを強調" }).uncheck();
  await sheet.getByRole("checkbox", { name: "残りの数を表示" }).uncheck();
  await sheet.getByRole("button", { name: "閉じる" }).click();
  await expect(sheet).toBeHidden();

  await expect(page.locator(".cell.selected")).toHaveCount(1);
  await expect(page.locator(".cell.peer")).toHaveCount(0);
  await expect(page.locator(".pad-key.is-done")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /残り/ })).toHaveCount(0);
  await expect(page.locator(".pad-left")).toHaveText(Array(9).fill(""));
});

test("「ヒントの前に確認」をオンにすると、ヒントを開く前に確認する", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "設定" }).click();
  const settings = page.getByRole("dialog", { name: "設定" });
  await settings.getByRole("checkbox", { name: "ヒントの前に確認" }).check();
  await settings.getByRole("button", { name: "閉じる" }).click();
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();

  await page.getByRole("button", { name: "ヒント" }).click();
  const confirm = page.getByRole("dialog", { name: "ヒントを見ますか？" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("コンボが切れます");
  await expect(page.locator(".hint-panel")).toHaveCount(0);
  await confirm.getByRole("button", { name: "やめる" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator(".hint-panel")).toHaveCount(0);
  await expect(page.locator(".tool-count")).toHaveCount(0);

  // H キーも同じく確認してから開く
  await page.keyboard.press("h");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "見る" }).click();
  await expect(confirm).toBeHidden();
  await expect(page.locator(".hint-panel")).toBeVisible();
  await expect(page.locator(".tool-count")).toHaveText("1");
});

test("戻した数字を、進むボタンとキー（Ctrl+Shift+Z・Ctrl+Y・Shift+Z）で戻せる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const [cell, other] = g.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const cells = page.getByRole("gridcell");
  const target = cells.nth(cell);
  const digit = g.solution![cell];
  const placed = new RegExp(` ${digit}$`);
  // 「間違える前まで戻す」と取り違えないよう、ボタン名は完全一致で探す
  const undo = page.getByRole("button", { name: "戻す", exact: true });
  const redo = page.getByRole("button", { name: "進む", exact: true });
  await expect(redo).toBeDisabled();

  await target.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${digit}`);
  await expect(target).toHaveAttribute("aria-label", placed);
  await undo.click();
  await expect(target).toHaveAttribute("aria-label", /空き$/);
  await expect(redo).toBeEnabled();
  await shot(page, "redo");
  await redo.click();
  await expect(target).toHaveAttribute("aria-label", placed);
  await expect(redo).toBeDisabled();

  for (const key of ["Control+Shift+KeyZ", "Control+KeyY", "Shift+KeyZ"]) {
    await page.keyboard.press("Control+KeyZ");
    await expect(target).toHaveAttribute("aria-label", /空き$/);
    await page.keyboard.press(key);
    await expect(target, key).toHaveAttribute("aria-label", placed);
  }

  // 戻したあとに別の数字を置くと、進めなくなる
  await undo.click();
  await expect(redo).toBeEnabled();
  await cells.nth(other).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${g.solution![other]}`);
  await expect(redo).toBeDisabled();
  await page.keyboard.press("Shift+KeyZ");
  await expect(target).toHaveAttribute("aria-label", /空き$/);
});

test("今日の一問でも進むが使え、手の記録は増えず、進む手は保存しない", async ({ page }, info) => {
  await page.goto("/");
  await page.locator(".daily-row").nth(1).click();
  await page.getByPlaceholder("ニックネーム").fill(`進む${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  const solution = solve(g.puzzle)!;
  const cell = g.puzzle.indexOf(0);
  const target = page.getByRole("gridcell").nth(cell);
  const redo = page.getByRole("button", { name: "進む", exact: true });
  await target.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${solution[cell]}`);
  await expect(redo).toBeDisabled();
  await page.getByRole("button", { name: "戻す", exact: true }).click();
  await expect(target).toHaveAttribute("aria-label", /空き$/);
  await expect.poll(async () => (await savedGame(page, key)).values[cell]).toBe(0);
  expect(await savedGame(page, key)).not.toHaveProperty("future");
  await redo.click();
  await expect(target).toHaveAttribute("aria-label", new RegExp(` ${solution[cell]}$`));
  await expect(redo).toBeDisabled();
  await expect.poll(async () => (await savedGame(page, key)).values[cell]).toBe(solution[cell]);
  expect((await savedGame(page, key)).moves).toHaveLength(1);
});

test("Shift・Ctrl・Cmd+クリックで複数のマスを選ぶと、数字はメモとしてまとめて入り、消すはメモだけ消す", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const [a, b, c, d] = g.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const given = g.puzzle.findIndex((v) => v !== 0);
  const cells = page.getByRole("gridcell");
  const press = async (i: number, init: Record<string, unknown> = {}) => {
    await cells.nth(i).dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, ...init });
    await cells.nth(i).dispatchEvent("pointerup", { pointerType: "mouse", button: 0, ...init });
  };
  const placed = new RegExp(` ${g.solution![d]}$`);
  const pad = page.locator(".pad");
  // d には数字を置いておく
  await press(d);
  await page.keyboard.press(`Digit${g.solution![d]}`);
  await expect(cells.nth(d)).toHaveAttribute("aria-label", placed);
  await expect(pad).not.toHaveClass(/is-notes/);

  await press(a);
  await press(b, { shiftKey: true });
  await press(c, { ctrlKey: true });
  await press(d, { metaKey: true });
  await press(given, { shiftKey: true });
  await expect(cells.nth(a)).toHaveClass(/selected/);
  for (const i of [b, c, d, given]) await expect(cells.nth(i)).toHaveClass(/multi/);
  // メモが OFF のままでも、数字パッドはメモの見た目になる
  await expect(page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(pad).toHaveClass(/is-notes/);

  // 選んだ空きマスすべてに付け、もう一度で全部から外す。数字のあるマスはそのまま
  await page.keyboard.press("Digit3");
  for (const i of [a, b, c]) await expect(cells.nth(i).locator(".notes .on")).toHaveText(["3"]);
  await expect(cells.nth(d)).toHaveAttribute("aria-label", placed);
  await expect(cells.nth(given)).toHaveAttribute("aria-label", new RegExp(` ${g.puzzle[given]}$`));
  await page.keyboard.press("Digit3");
  for (const i of [a, b, c]) await expect(cells.nth(i).locator(".notes")).toHaveCount(0);

  await page.keyboard.press("Digit3");
  await page.locator(".pad-key").nth(4).click();
  for (const i of [a, b, c]) await expect(cells.nth(i).locator(".notes .on")).toHaveText(["3", "5"]);
  await shot(page, "multi-notes");
  // 消すはメモだけを消し、数字は残す
  await page.getByRole("button", { name: "消す", exact: true }).click();
  for (const i of [a, b, c]) await expect(cells.nth(i).locator(".notes")).toHaveCount(0);
  await expect(cells.nth(d)).toHaveAttribute("aria-label", placed);
  await page.getByRole("button", { name: "戻す", exact: true }).click();
  for (const i of [a, b, c]) await expect(cells.nth(i).locator(".notes .on")).toHaveText(["3", "5"]);
  // メモは保存し、選択は保存しない
  const both = (1 << 3) | (1 << 5);
  await expect.poll(async () => (await savedGame(page, "sudoku:free")).notes[b]).toBe(both);
  expect(await savedGame(page, "sudoku:free")).not.toHaveProperty("selection");

  // Esc で選択を外す
  await page.keyboard.press("Escape");
  await expect(page.locator(".cell.multi")).toHaveCount(0);
  await expect(page.locator(".cell.selected")).toHaveCount(0);
  await expect(pad).not.toHaveClass(/is-notes/);
});

/**
 * 盤面のマスにポインタイベントを送る関数を作る。start のマスに、at のマスの中の横位置 x（左端 0〜右端 1。既定は中央）・
 * 縦は中央の座標で送る。タッチでは押したマスにポインタが捕まり、動かしてもイベントは最初のマスに届くので、それに合わせる。
 * 位置は送る直前に測る
 */
function boardPointer(page: Page, pointerType: "mouse" | "touch") {
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  return (
    type: string,
    start: number,
    at: number,
    init: { x?: number; buttons?: number; pointerType?: "mouse" | "touch" } = {},
  ) =>
    board.evaluate(
      (el, { type, start, at, x, buttons, pointerType }) => {
        const all = el.querySelectorAll("[data-i]");
        const r = all[at].getBoundingClientRect();
        all[start].dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 7,
            pointerType,
            isPrimary: true,
            button: type === "pointermove" ? -1 : 0,
            buttons,
            clientX: r.left + r.width * x,
            clientY: r.top + r.height / 2,
          }),
        );
      },
      {
        type,
        start,
        at,
        x: init.x ?? 0.5,
        buttons: init.buttons ?? (type === "pointerdown" || type === "pointermove" ? 1 : 0),
        pointerType: init.pointerType ?? pointerType,
      },
    );
}

test("盤面をなぞって複数のマスを選べる。離すか取り消されたら、それ以上は足さない", async ({ page }, info) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  await expect(board).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cells = page.getByRole("gridcell");
  const pointer = boardPointer(page, info.project.use.hasTouch ? "touch" : "mouse");

  // 空きマスが 2 つ以上ある行を、左端から右端までなぞる
  const row = [0, 1, 2, 3, 4, 5, 6, 7, 8].find(
    (r) => g.puzzle.slice(r * 9, r * 9 + 9).filter((v) => !v).length >= 2,
  )!;
  const path = Array.from({ length: 9 }, (_, c) => row * 9 + c);
  const others = g.puzzle.flatMap((v, i) => (v || Math.floor(i / 9) === row ? [] : [i]));
  await pointer("pointerdown", path[0], path[0]);
  for (const i of path.slice(1)) await pointer("pointermove", path[0], i);
  await pointer("pointerup", path[0], path[8]);
  await expect(cells.nth(path[0])).toHaveClass(/selected/);
  await expect(page.locator(".cell.multi")).toHaveCount(8);
  for (const i of path.slice(1)) await expect(cells.nth(i)).toHaveClass(/multi/);
  // 離したあとに動かしても足さない（次の数字が入らないことで確かめる）
  await pointer("pointermove", path[0], others[0]);
  await page.keyboard.press("Digit7");
  for (const i of path.filter((i) => !g.puzzle[i])) {
    await expect(cells.nth(i).locator(".notes .on")).toHaveText(["7"]);
  }
  await expect(cells.nth(others[0]).locator(".notes")).toHaveCount(0);
  await expect(page.locator(".cell.multi")).toHaveCount(8);

  // 取り消し（pointercancel）でも終わる
  const [p, q, x] = others.slice(1);
  await pointer("pointerdown", p, p);
  await pointer("pointermove", p, q);
  await pointer("pointercancel", p, q);
  await pointer("pointermove", p, x);
  await page.keyboard.press("Digit8");
  for (const i of [p, q]) await expect(cells.nth(i).locator(".notes .on")).toHaveText(["8"]);
  await expect(cells.nth(x).locator(".notes")).toHaveCount(0);
  await expect(page.locator(".cell.multi")).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.locator(".cell.multi")).toHaveCount(0);
});

test("指のぶれ程度なら、隣のマスに掛かってもなぞったことにしない。マウスのボタンが離れていたら終える", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cells = page.getByRole("gridcell");
  const pointer = boardPointer(page, info.project.use.hasTouch ? "touch" : "mouse");
  // 右隣のある空きマス
  const [a, e] = g.puzzle.flatMap((v, i) => (v || i % 9 === 8 ? [] : [i]));
  const placed = (i: number) => new RegExp(` ${g.solution![i]}$`);

  // 押した点からマス幅の 4 割だけ動かし、右隣のマスとの境目をまたぐ。選択は増えず、数字は値として入る
  await pointer("pointerdown", a, a, { x: 0.8 });
  await pointer("pointermove", a, a + 1, { x: 0.2 });
  await pointer("pointerup", a, a + 1, { x: 0.2 });
  await page.keyboard.press(`Digit${g.solution![a]}`);
  await expect(cells.nth(a)).toHaveAttribute("aria-label", placed(a));
  await expect(page.locator(".cell.multi")).toHaveCount(0);

  // マス幅の半分より動けば、なぞったことになる
  await pointer("pointerdown", a, a, { x: 0.8 });
  await pointer("pointermove", a, a + 1, { x: 0.2 });
  await pointer("pointermove", a, a + 1, { x: 0.5 });
  await pointer("pointerup", a, a + 1, { x: 0.5 });
  await expect(cells.nth(a + 1)).toHaveClass(/multi/);
  await expect(page.locator(".cell.multi")).toHaveCount(1);
  await page.keyboard.press("Escape");

  // マウスのボタンが離れていれば、pointerup が届かなくてもそれ以上は足さない
  await pointer("pointerdown", e, e, { pointerType: "mouse" });
  await pointer("pointermove", e, e + 1, { pointerType: "mouse", buttons: 0 });
  await pointer("pointermove", e, e + 1, { pointerType: "mouse" });
  await page.keyboard.press(`Digit${g.solution![e]}`);
  await expect(cells.nth(e)).toHaveAttribute("aria-label", placed(e));
  await expect(page.locator(".cell.multi")).toHaveCount(0);
});

/** マスの呼び名（読み上げ名の先頭） */
const cellAt = (i: number) => `${Math.floor(i / 9) + 1}行${(i % 9) + 1}列`;

/** 盤面の読み上げ欄（置いた結果などを知らせる） */
const boardLive = (page: Page) => page.locator(".board-wrap [role='status']");

test("盤面は 9 行・81 マスの表として読み上げる。マスの名前で最初から・間違い・メモを言い、選んだマスは aria-selected で示す", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  await expect(board).toBeVisible();
  await expect(board).toHaveAttribute("aria-multiselectable", "true");
  const rows = board.getByRole("row");
  await expect(rows).toHaveCount(9);
  for (let r = 0; r < 9; r++) await expect(rows.nth(r).getByRole("gridcell")).toHaveCount(9);
  const cells = board.getByRole("gridcell");
  await expect(cells).toHaveCount(81);
  // 行を挟んでも、マスは盤面の番号の順に並ぶ
  await expect(rows.nth(4).getByRole("gridcell").nth(4)).toHaveAttribute("data-i", "40");
  // 行を挟んでも、右端の列と下端の行のマスには外側の線を引かない
  const borders = await board.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("[data-i]")].map((c) => {
      const s = getComputedStyle(c);
      return [parseFloat(s.borderRightWidth) > 0, parseFloat(s.borderBottomWidth) > 0];
    }),
  );
  expect(borders[0]).toEqual([true, true]);
  expect(borders[8]).toEqual([false, true]);
  expect(borders[72]).toEqual([true, false]);
  expect(borders[80]).toEqual([false, false]);

  const g = await savedGame(page, "sudoku:free");
  const given = g.puzzle.findIndex((v) => v !== 0);
  const [a, b] = g.puzzle.flatMap((v, i) => (v ? [] : [i]));
  await expect(cells.nth(given)).toHaveAttribute(
    "aria-label",
    `${cellAt(given)} 最初から ${g.puzzle[given]}`,
  );
  await expect(cells.nth(a)).toHaveAttribute("aria-label", `${cellAt(a)} 空き`);
  await expect(board.locator("[aria-selected='true']")).toHaveCount(0);

  await cells.nth(a).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await expect(cells.nth(a)).toHaveAttribute("aria-selected", "true");
  await expect(board.locator("[aria-selected='true']")).toHaveCount(1);
  await page.keyboard.press("Shift+Digit3");
  await page.keyboard.press("Shift+Digit1");
  await expect(cells.nth(a)).toHaveAttribute("aria-label", `${cellAt(a)} メモ1・3 空き`);
  const wrong = (g.solution![a] % 9) + 1;
  await page.keyboard.press(`Digit${wrong}`);
  await expect(cells.nth(a)).toHaveAttribute("aria-label", `${cellAt(a)} 間違い ${wrong}`);
  await page.keyboard.press(`Digit${g.solution![a]}`);
  await expect(cells.nth(a)).toHaveAttribute("aria-label", `${cellAt(a)} ${g.solution![a]}`);

  // 複数選択では、選んだマスすべてに付ける
  await cells.nth(b).dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, shiftKey: true });
  await cells.nth(b).dispatchEvent("pointerup", { pointerType: "mouse", button: 0, shiftKey: true });
  for (const i of [a, b]) await expect(cells.nth(i)).toHaveAttribute("aria-selected", "true");
  await expect(board.locator("[aria-selected='true']")).toHaveCount(2);
});

test("Tab では盤面の 1 マスにだけ止まり、矢印キーで選ぶとフォーカスも動く。フォーカスしたマスは Enter・Space で選ぶ", async ({
  page,
}, info) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  await expect(board).toBeVisible();
  const cells = board.getByRole("gridcell");
  const stop = board.locator("[tabindex='0']");
  const pause = page.getByRole("button", { name: "一時停止", exact: true });
  // 何も選んでいなければ、中央のマスに止まる
  await expect(stop).toHaveCount(1);
  await expect(stop).toHaveAttribute("data-i", "40");
  await expect(board.locator("[tabindex='-1']")).toHaveCount(80);

  if (isIphone(info)) {
    // iPhone の Safari は Tab でボタンに止まらないので、フォーカスを直接移す
    await cells.nth(40).focus();
  } else {
    // 盤面の前のボタンから Tab で入るとそのマスに止まり、もう一度 Tab で盤面の外へ出る
    await pause.focus();
    await page.keyboard.press("Tab");
    await expect(cells.nth(40)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(board.locator(":focus")).toHaveCount(0);
    await expect(page.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Shift+Tab");
    await expect(cells.nth(40)).toBeFocused();
  }

  // 矢印キーで選ぶと、フォーカスも付いてくる（何も選んでいなければ中央から動く）
  await page.keyboard.press("ArrowRight");
  await expect(cells.nth(41)).toBeFocused();
  await expect(cells.nth(41)).toHaveAttribute("aria-selected", "true");
  await expect(stop).toHaveCount(1);
  await expect(stop).toHaveAttribute("data-i", "41");
  await page.keyboard.press("ArrowDown");
  await expect(cells.nth(50)).toBeFocused();
  await expect(board.locator("[aria-selected='true']")).toHaveCount(1);

  // 選択を外しても、止まるのは最後に選んだマス。フォーカスしたマスは Enter・Space で選ぶ（Space で一時停止にしない）
  await page.keyboard.press("Escape");
  await expect(board.locator("[aria-selected='true']")).toHaveCount(0);
  await expect(stop).toHaveAttribute("data-i", "50");
  await page.keyboard.press("Enter");
  await expect(cells.nth(50)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Space");
  await expect(cells.nth(50)).toHaveAttribute("aria-selected", "true");
  await expect(pause).toBeVisible();

  // 選択を外した後の矢印キーは、中央ではなくフォーカスしているマスから動かす
  await page.keyboard.press("Escape");
  await page.keyboard.press("ArrowRight");
  await expect(cells.nth(51)).toBeFocused();
  await expect(cells.nth(51)).toHaveAttribute("aria-selected", "true");

  // 盤面の外にフォーカスがあるときは、矢印キーで選んでもフォーカスを動かさない
  const key = page.locator(".pad-key").first();
  await key.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(cells.nth(50)).toHaveAttribute("aria-selected", "true");
  await expect(key).toBeFocused();

  // 戻すで選択が動いても、フォーカスは動かさない（動いた先のマスは読み上げ欄で知らせる）
  const g = await savedGame(page, "sudoku:free");
  const e = g.puzzle.findIndex((v, i) => !v && i % 9 < 8);
  await cells.nth(e).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press(`Digit${g.solution![e]}`);
  await page.keyboard.press("ArrowRight");
  await expect(cells.nth(e + 1)).toBeFocused();
  await page.keyboard.press("z");
  await expect(cells.nth(e)).toHaveAttribute("aria-selected", "true");
  await expect(cells.nth(e)).toHaveAttribute("aria-label", `${cellAt(e)} 空き`);
  await expect(boardLive(page)).toHaveText(`戻す ${cellAt(e)} 空き`);
  await expect(cells.nth(e + 1)).toBeFocused();
});

test("click だけが届く操作（読み上げソフトのダブルタップなど）でも、マスと数字キーが 1 回ずつ効く。置いた結果とヒントを読み上げ欄で知らせる", async ({
  page,
}) => {
  const sounds = await countSounds(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  await expect(board).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const [a, b, c] = g.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const cells = board.getByRole("gridcell");
  const keys = page.locator(".pad-key");
  const live = boardLive(page);
  const notesTool = page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ });

  // 選ぶ音の数で、選ぶ処理が何回動いたかを数える。押した時点で選ぶ（pointerdown だけ）のを 1 回とする
  const selectSounds = async (act: () => Promise<void>) => {
    await nextFrames(page);
    const before = await sounds();
    await act();
    await nextFrames(page);
    return (await sounds()) - before;
  };
  const once = await selectSounds(() =>
    cells.nth(b).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 }),
  );
  expect(once).toBeGreaterThan(0);
  // 実際のクリック（pointerdown の後に click）でも、click だけでも 1 回
  expect(await selectSounds(() => cells.nth(c).click())).toBe(once);
  await expect(cells.nth(c)).toHaveAttribute("aria-selected", "true");
  expect(await selectSounds(() => cells.nth(a).dispatchEvent("click"))).toBe(once);
  await expect(cells.nth(a)).toHaveAttribute("aria-selected", "true");
  await expect(board.locator("[aria-selected='true']")).toHaveCount(1);

  // 数字キーも click だけで 1 回入る
  await keys.nth(g.solution![a] - 1).dispatchEvent("click");
  await expect(cells.nth(a)).toHaveAttribute("aria-label", `${cellAt(a)} ${g.solution![a]}`);
  await expect(live).toHaveText(`${cellAt(a)}に ${g.solution![a]}`);

  // メモは、実際のクリックでも click だけでも 1 回ずつ切り替わる
  await cells.nth(c).click();
  await notesTool.click();
  await keys.nth(2).click();
  await expect(cells.nth(c)).toHaveAttribute("aria-label", `${cellAt(c)} メモ3 空き`);
  await expect(live).toHaveText(`${cellAt(c)} メモ3 追加`);
  await keys.nth(2).dispatchEvent("click");
  await expect(cells.nth(c)).toHaveAttribute("aria-label", `${cellAt(c)} 空き`);
  await expect(live).toHaveText(`${cellAt(c)} メモ3 削除`);
  await keys.nth(2).dispatchEvent("click");
  await expect(cells.nth(c)).toHaveAttribute("aria-label", `${cellAt(c)} メモ3 空き`);

  // 間違いは「間違い」を付けて知らせる
  await notesTool.click();
  const wrong = (g.solution![c] % 9) + 1;
  await keys.nth(wrong - 1).click();
  await expect(cells.nth(c)).toHaveAttribute("aria-label", `${cellAt(c)} 間違い ${wrong}`);
  await expect(live).toHaveText(`${cellAt(c)}に ${wrong} 間違い`);

  // ヒント（違う数字のヒントは説明から見せる）は、名前と説明と対象のマスを知らせる
  await page.getByRole("button", { name: "ヒント", exact: true }).click();
  await expect(page.locator(".hint-panel")).toBeVisible();
  await expect(live).toHaveText(`ヒント 違う数字があります このマスの数字が違います 対象 ${cellAt(c)}`);
});

test("色を ON にすると数字パッドが色に変わり、選んだマスに色を付け外しする。消す・戻す・C キー・再読み込み", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const [a, b] = g.puzzle.flatMap((v, i) => (v ? [] : [i]));
  const given = g.puzzle.findIndex((v) => v !== 0);
  const cells = page.getByRole("gridcell");
  const press = async (i: number, init: Record<string, unknown> = {}) => {
    await cells.nth(i).dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, ...init });
    await cells.nth(i).dispatchEvent("pointerup", { pointerType: "mouse", button: 0, ...init });
  };
  const mark = (i: number) => cells.nth(i).locator(".mark");
  const pad = page.locator(".pad");
  const colorTool = page.getByRole("button", { name: /^(ON|OFF) ?色$/ });
  const notesTool = page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ });

  await press(a);
  await colorTool.click();
  await expect(colorTool).toHaveAttribute("aria-pressed", "true");
  await expect(pad).toHaveClass(/is-colors/);
  await expect(pad.locator(".swatch")).toHaveCount(9);
  // 色相だけに頼らないよう、色には番号を添える
  await expect(pad.locator(".swatch-num")).toHaveText(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  await expect(pad.locator(".pad-digit")).toHaveCount(0);
  await page.getByRole("button", { name: "色3", exact: true }).click();
  await expect(mark(a)).toHaveAttribute("data-color", "3");
  await expect(cells.nth(a)).toHaveAttribute("aria-label", /空き 色3$/);

  // 複数選択では、最初から入っているマスも含めて全部に付け、全部が同じ色ならもう一度で外す。数字キーでも選べる
  await press(b, { shiftKey: true });
  await press(given, { shiftKey: true });
  await page.keyboard.press("Digit5");
  for (const i of [a, b, given]) await expect(mark(i)).toHaveAttribute("data-color", "5");
  await expect(cells.nth(given)).toHaveAttribute("aria-label", new RegExp(` ${g.puzzle[given]} 色5$`));
  await page.keyboard.press("Digit5");
  for (const i of [a, b, given]) await expect(mark(i)).toHaveCount(0);
  await page.keyboard.press("Digit5");
  for (const i of [a, b, given]) await expect(mark(i)).toHaveAttribute("data-color", "5");
  await shot(page, "colors");

  // 消すは色だけを外し、戻すで戻る
  await page.getByRole("button", { name: "消す", exact: true }).click();
  for (const i of [a, b, given]) await expect(mark(i)).toHaveCount(0);
  await expect(cells.nth(given)).toHaveAttribute("aria-label", new RegExp(` ${g.puzzle[given]}$`));
  await page.getByRole("button", { name: "戻す", exact: true }).click();
  for (const i of [a, b, given]) await expect(mark(i)).toHaveAttribute("data-color", "5");

  // メモとは同時にオンにならない。C キーで切り替える
  await notesTool.click();
  await expect(notesTool).toHaveAttribute("aria-pressed", "true");
  await expect(colorTool).toHaveAttribute("aria-pressed", "false");
  await expect(pad).not.toHaveClass(/is-colors/);
  await page.keyboard.press("c");
  await expect(colorTool).toHaveAttribute("aria-pressed", "true");
  await expect(notesTool).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("c");
  await expect(colorTool).toHaveAttribute("aria-pressed", "false");
  // 色モードを外すと、複数選択中なので数字はメモに戻る
  await expect(pad).not.toHaveClass(/is-colors/);
  await expect(pad).toHaveClass(/is-notes/);

  // 色は保存し、開き直しても残る
  await expect.poll(async () => (await savedGame(page, "sudoku:free")).colors?.[given]).toBe(5);
  await page.reload();
  await page.getByRole("button", { name: /続きから/ }).click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  for (const i of [a, b, given]) await expect(mark(i)).toHaveAttribute("data-color", "5");
});

test("今日の一問でも色が使え、手の記録は増えない", async ({ page }, info) => {
  await page.goto("/");
  await page.locator(".daily-row").nth(1).click();
  await page.getByPlaceholder("ニックネーム").fill(`色${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  const cell = g.puzzle.indexOf(0);
  const given = g.puzzle.findIndex((v) => v !== 0);
  const cells = page.getByRole("gridcell");
  await cells.nth(cell).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press("c");
  await page.keyboard.press("Digit4");
  await cells.nth(given).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press("Digit7");
  await expect(cells.nth(cell).locator(".mark")).toHaveAttribute("data-color", "4");
  await expect(cells.nth(given).locator(".mark")).toHaveAttribute("data-color", "7");
  await expect.poll(async () => (await savedGame(page, key)).colors?.[given]).toBe(7);
  const saved = await savedGame(page, key);
  expect(saved.moves).toEqual([]);
  expect(saved.values).toEqual(g.values);
});

test("色を付けたマスでも、間違い・手筋ヒント・複数選択の基準のマスが分かるよう、色の上に印を描く。間違いの数字には色によらず下線を引く", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cells = page.getByRole("gridcell");
  const press = async (i: number, init: Record<string, unknown> = {}) => {
    await cells.nth(i).dispatchEvent("pointerdown", { pointerType: "mouse", button: 0, ...init });
    await cells.nth(i).dispatchEvent("pointerup", { pointerType: "mouse", button: 0, ...init });
  };
  const mark = (i: number) => cells.nth(i).locator(".mark");
  const panel = page.locator(".hint-panel");
  // 色は今の配色で計算した値どうしで比べる（書き方がブラウザごとに違うので、固定の値は使わない）
  const resolve = (value: string) =>
    page.evaluate((v) => {
      const el = document.createElement("span");
      el.style.color = v;
      document.body.append(el);
      const color = getComputedStyle(el).color;
      el.remove();
      return color;
    }, value);
  const styleOf = (i: number, pseudo: "::before" | "::after" | null = null) =>
    mark(i).evaluate((el, pseudo) => {
      const cs = getComputedStyle(el, pseudo);
      return {
        boxShadow: cs.boxShadow,
        background: cs.backgroundColor,
        clipPath: cs.clipPath,
        width: cs.width,
        borderStyle: cs.borderTopStyle,
        borderColor: cs.borderTopColor,
      };
    }, pseudo);
  /** box-shadow（inset 0 0 0 Npx）の太さ */
  const ringWidth = (shadow: string) => Number(/([\d.]+)px inset/.exec(shadow)?.[1] ?? 0);
  const digitOf = (i: number) =>
    cells
      .nth(i)
      .locator(".digit")
      .evaluate((el) => ({
        color: getComputedStyle(el).color,
        weight: Number(getComputedStyle(el).fontWeight),
      }));
  /** 数字の下線（間違いの印） */
  const underlineOf = (i: number) =>
    cells
      .nth(i)
      .locator(".digit")
      .evaluate((el) => ({
        line: getComputedStyle(el).textDecorationLine,
        style: getComputedStyle(el).textDecorationStyle,
      }));

  // 手筋ヒントで注目する範囲のマスは、色を付けても点線の枠で分かる。色を変えてもヒントは閉じない。
  // ヒントはボタンで開く（キーを受け付けるのは盤面を描いた後の useEffect からなので、描いた直後の H キーは
  // 取りこぼすことがある。H キーは「ヒントの前に確認」のテストで確かめる）
  await page.getByRole("button", { name: "ヒント", exact: true }).click();
  await expect(page.locator(".cell.hint-focus").first()).toBeVisible();
  const focus = Number(await page.locator(".cell.hint-focus").first().getAttribute("data-i"));
  await press(focus);
  await page.keyboard.press("c");
  await page.keyboard.press("Digit2");
  await expect(mark(focus)).toHaveAttribute("data-color", "2");
  await expect(panel).toBeVisible();
  await expect(cells.nth(focus)).toHaveClass(/hint-focus/);
  const gold = await resolve("var(--gold-on-mark)");
  expect(await styleOf(focus, "::before")).toMatchObject({ borderStyle: "dotted", borderColor: gold });

  // 置く・消すの対象のマスは、色の上でも実線の枠（点線・破線の枠ではない）
  await panel.getByRole("button", { name: "もっと見る" }).click();
  await expect(page.locator(".cell.hint-target").first()).toBeVisible();
  const target = Number(await page.locator(".cell.hint-target").first().getAttribute("data-i"));
  await press(target);
  await page.keyboard.press("Digit3");
  await expect(mark(target)).toHaveAttribute("data-color", "3");
  await expect(panel).toBeVisible();
  const ring = (await styleOf(target)).boxShadow;
  expect(ring).toContain(gold);
  expect(ringWidth(ring)).toBeGreaterThan(0);
  expect((await styleOf(target, "::before")).borderStyle).toBe("none");
  await shot(page, "colors-hint");
  await page.getByRole("button", { name: "ヒントを閉じる" }).click();

  // 間違えた数字のマスは、色で赤い背景が隠れても、角の三角と濃く太い数字で分かる。
  // 赤が見分けにくくても分かるよう、色の有無によらず数字に波線の下線を引く（c には色を付けない）
  const [a, b, c] = g.puzzle.flatMap((v, i) => (v || i === focus || i === target ? [] : [i]));
  await page.keyboard.press("c");
  for (const i of [a, b, c]) {
    await press(i);
    await page.keyboard.press(`Digit${(g.solution![i] % 9) + 1}`);
  }
  await page.keyboard.press("c");
  for (const [i, color] of [
    [a, 6],
    [b, 9],
  ]) {
    await press(i);
    await page.keyboard.press(`Digit${color}`);
    await expect(mark(i)).toHaveAttribute("data-color", String(color));
  }
  const danger = await resolve("var(--danger-on-mark)");
  expect(danger).not.toBe(await resolve("var(--danger)"));
  for (const i of [a, b]) {
    await expect(cells.nth(i)).toHaveClass(/wrong/);
    const flag = await styleOf(i, "::after");
    expect(flag.background).toBe(danger);
    expect(flag.clipPath).not.toBe("none");
    expect(parseFloat(flag.width)).toBeGreaterThan((await cells.nth(i).boundingBox())!.width * 0.2);
    expect(await digitOf(i)).toEqual({ color: danger, weight: 700 });
  }
  await expect(cells.nth(c)).toHaveClass(/wrong/);
  await expect(mark(c)).toHaveCount(0);
  for (const i of [a, b, c]) expect(await underlineOf(i)).toEqual({ line: "underline", style: "wavy" });

  // 複数選択では、基準のマスの枠を他の選択マスより太くする。基準のマスに色が無くても同じ
  // （色の無い基準のマスは、行き詰まりにならない最初から入っているマスで確かめる）
  const plain = g.puzzle.findIndex((v, i) => v !== 0 && i !== focus);
  expect((await underlineOf(plain)).line).toBe("none");
  await press(plain);
  await press(a, { shiftKey: true });
  await expect(cells.nth(a)).toHaveClass(/multi/);
  const plainBase = await cells.nth(plain).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ringWidth(plainBase)).toBeGreaterThan(ringWidth((await styleOf(a)).boxShadow));
  await press(a);
  await press(b, { shiftKey: true });
  await press(plain, { shiftKey: true });
  await expect(cells.nth(plain)).toHaveClass(/multi/);
  await expect(cells.nth(a)).toHaveClass(/selected/);
  expect(ringWidth((await styleOf(a)).boxShadow)).toBeGreaterThan(ringWidth((await styleOf(b)).boxShadow));
  expect(ringWidth((await styleOf(b)).boxShadow)).toBeGreaterThan(0);
  await shot(page, "colors-marks");

  // ダークでも、間違いの印と数字は色の上で読める色に変わる
  await page.emulateMedia({ colorScheme: "dark" });
  const darkDanger = await resolve("var(--danger-on-mark)");
  expect(darkDanger).not.toBe(danger);
  expect((await styleOf(a, "::after")).background).toBe(darkDanger);
  expect((await digitOf(a)).color).toBe(darkDanger);
  // マスの背景の切り替え（transition）が終わってから撮る
  await page.waitForTimeout(300);
  await shot(page, "colors-marks-dark");

  // コントラストを上げる設定では、色の無いマスでも間違いの数字を濃く太くする
  await page.emulateMedia({ colorScheme: "light", contrast: "more" });
  expect(await digitOf(c)).toEqual({ color: await resolve("var(--danger-on-mark)"), weight: 700 });
  expect(await underlineOf(c)).toEqual({ line: "underline", style: "wavy" });
});

/**
 * ツールの並びで、メモ・色の ON/OFF のバッジがはみ出していないか。
 * 掛かった部分を叩くと隣ではなくバッジのボタンが反応するので、ボタンの左右からはみ出さないこと。
 * 位置は文字の幅で変わるので、固定の座標ではなく実際の矩形どうしで比べる。
 * 横向きでは上へも 4px ほどはみ出すが、そこにボタンは無いので見ない
 */
function toolBadgeProblems(page: Page) {
  return page.evaluate(() => {
    const tools = [...document.querySelectorAll(".tools .tool")];
    const rects = tools.map((t) => t.getBoundingClientRect());
    const problems: string[] = [];
    let badges = 0;
    tools.forEach((tool, i) => {
      const badge = tool.querySelector(".tool-badge");
      if (!badge) return;
      badges++;
      const b = badge.getBoundingClientRect();
      const own = rects[i];
      if (b.left < own.left - 0.5 || b.right > own.right + 0.5) {
        const [l, r] = [own.left - b.left, b.right - own.right].map((v) => v.toFixed(1));
        problems.push(`${tool.textContent}: ボタンの外へはみ出す（左 ${l}px・右 ${r}px）`);
      }
      rects.forEach((other, j) => {
        const w = Math.min(b.right, other.right) - Math.max(b.left, other.left);
        const h = Math.min(b.bottom, other.bottom) - Math.max(b.top, other.top);
        if (j !== i && w > 0.5 && h > 0)
          problems.push(`${tool.textContent} → ${tools[j].textContent}: ${w.toFixed(1)}px`);
      });
    });
    return { badges, problems };
  });
}

test("フリープレイの 7 つ並びでも、メモ・色の ON/OFF のバッジが隣のボタンに掛からない", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  await expect(page.locator(".tools.is-dense .tool")).toHaveCount(7);
  const notesTool = page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ });

  for (const size of [
    page.viewportSize()!,
    { width: 300, height: 640 },
    { width: 320, height: 568 },
    { width: 393, height: 852 },
    { width: 568, height: 320 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForFunction((width) => window.innerWidth === width, size.width);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // 「OFF」がいちばん幅を取る。メモを ON にすると色のバッジは OFF のまま残る
    for (const on of [false, true]) {
      if ((await notesTool.getAttribute("aria-pressed")) !== String(on)) await notesTool.click();
      await expect(notesTool).toHaveAttribute("aria-pressed", String(on));
      expect(await toolBadgeProblems(page), `${size.width}x${size.height} メモ${on ? "ON" : "OFF"}`).toEqual({
        badges: 2,
        problems: [],
      });
    }
    await shot(page, `tools-${size.width}x${size.height}`);
  }
});

const PRACTICE = practiceItems(PRACTICE_POSITIONS);
const practiceItem = (key: string) => PRACTICE.find((item) => item.key === key)!;

/** ホームから手筋の練習の一覧を開き、項目が出るまで待つ（局面のデータは開くときに読む） */
async function openPracticeList(page: Page) {
  await page.getByRole("button", { name: "手筋の練習" }).click();
  await expect(page.locator(".practice-row")).toHaveCount(PRACTICE.length);
}

async function openPracticeItem(page: Page, item: PracticeItem) {
  await page.locator(".practice-name").getByText(item.name, { exact: true }).click();
  await expect(page.getByRole("heading", { name: item.name })).toBeVisible();
}

/** 練習の画面に出ている局面 */
async function practicePosition(page: Page, item: PracticeItem) {
  const id = await page.locator(".practice").getAttribute("data-position");
  const position = item.positions.find((p) => p.id === id);
  expect(position, `局面 ${id}`).toBeDefined();
  return position!;
}

/** 練習の一覧の、項目ごとの「解いた数/局面の数」 */
const practiceCount = (page: Page, item: PracticeItem) =>
  page
    .locator(".practice-row")
    .filter({ has: page.getByText(item.name, { exact: true }) })
    .locator(".practice-count");

/**
 * 合成した効果音の数（Web Audio のオシレーターを作った回数）を数え始め、数を読む関数を返す。page.goto の前に呼ぶ
 */
async function countSounds(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __sounds: number };
    w.__sounds = 0;
    const proto = BaseAudioContext.prototype;
    const create = proto.createOscillator;
    proto.createOscillator = function (this: BaseAudioContext) {
      w.__sounds++;
      return create.call(this);
    };
  });
  return () => page.evaluate(() => (window as unknown as { __sounds: number }).__sounds);
}

/** 入力の反映と描画を待つ */
const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** シートを ×・Escape・背景のタップで閉じようとしても、閉じない（処理中）ことを確かめる */
async function expectNotClosable(dialog: Locator) {
  const page = dialog.page();
  await expect(dialog.getByRole("button", { name: "閉じる" })).toBeDisabled();
  await page.keyboard.press("Escape");
  // 背景（シートの外）をタップする
  await dialog.click({ position: { x: 5, y: 5 } });
  await nextFrames(page);
  await expect(dialog).toBeVisible();
}

/** 開いたときのログインの状態の確認（GET /api/auth/me）の応答。origin があればその URL のものだけ */
const authChecked = (page: Page, origin?: string) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/auth/me" && (!origin || new URL(r.url()).origin === origin),
  );

/** 端末に保存したフリープレイと記録、保存しているキー（今日の一問の履歴は裏で取り直して保存するので除く） */
const savedState = (page: Page) =>
  page.evaluate(() => ({
    free: localStorage.getItem("sudoku:free"),
    stats: localStorage.getItem("sudoku:stats"),
    keys: Object.keys(localStorage)
      .filter((k) => k !== "sudoku:history")
      .sort(),
  }));

test("手筋の練習：シングルを置いて正解し、次へ進む。戻るで一覧へ。進み具合は再読み込み後も残り、フリープレイの保存と記録は変わらない", async ({
  page,
}) => {
  const sounds = await countSounds(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await page.evaluate(() =>
    localStorage.setItem(
      "sudoku:stats",
      JSON.stringify({ easy: { played: 1, bestMs: 60_000, cleanBestMs: null, bestPoints: 100 } }),
    ),
  );
  const before = await savedState(page);
  await shot(page, "practice-home");

  await openPracticeList(page);
  await expect(page.locator(".practice-name")).toHaveText(PRACTICE.map((item) => item.name));
  await expect(page.locator(".practice-count")).toHaveText(
    PRACTICE.map((item) => `0/${item.positions.length}`),
  );
  await shot(page, "practice-list");

  const single = practiceItem("naked-single");
  const total = single.positions.length;
  await openPracticeItem(page, single);
  await expect(page.locator(".bar-kicker")).toHaveText(`手筋の練習 · 1/${total}`);
  await expect(page.locator(".practice-status")).toHaveText("置けるマスに数字を置く");
  // 時計・スコア・一時停止・得点は出さず、自動メモも隠す
  await expect(page.locator(".clock, .score-value, .popups")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /一時停止|自動メモ/ })).toHaveCount(0);
  await expect(page.locator(".tools .tool")).toHaveCount(6);
  // 始めのメモは候補をすべて書いた状態から removed を除いたもの
  const first = await practicePosition(page, single);
  const cells = page.getByRole("gridcell");
  const notes = startNotes(first);
  const empty = first.values.indexOf(0);
  await expect(cells.nth(empty).locator(".notes .on")).toHaveText(
    [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => notes[empty] & (1 << d)).map(String),
  );
  await shot(page, "practice-single");

  // 違う数字は誤りとして示し、消せば消える
  const { cell, digit } = answerOf(first).placement!;
  const target = cells.nth(cell);
  await target.dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${(digit % 9) + 1}`);
  await expect(page.locator(".stuck-bar")).toHaveText("違う数字があります");
  await expect(target).toHaveClass(/wrong/);
  await page.keyboard.press("Backspace");
  await expect(page.locator(".stuck-bar")).toHaveCount(0);
  // 正解する前は N でメモを切り替えると音が鳴る（音を数えられていることの確認）
  const notesTool = page.getByRole("button", { name: /^(ON|OFF) ?メモ$/ });
  const beforeToggle = await sounds();
  await page.keyboard.press("n");
  await expect(notesTool).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("n");
  await expect(notesTool).toHaveAttribute("aria-pressed", "false");
  expect(await sounds()).toBeGreaterThanOrEqual(beforeToggle + 2);
  await page.keyboard.press(`Digit${digit}`);
  const result = page.locator(".practice-result");
  await expect(result).toContainText("正解");
  await expect(boardLive(page)).toHaveText(/^正解/);
  await shot(page, "practice-correct");
  // 正解したら盤面は変えず、キーを押しても音を鳴らさない（消す・移動・メモ切替・色切替・数字）
  await nextFrames(page);
  const afterSolved = await sounds();
  for (const key of ["Backspace", "ArrowRight", "n", "c", `Digit${(digit % 9) + 1}`])
    await page.keyboard.press(key);
  await nextFrames(page);
  expect(await target.getAttribute("aria-label")).toMatch(new RegExp(` ${digit}$`));
  expect(
    await page.locator(".cell.selected").evaluateAll((els) => els.map((el) => el.getAttribute("data-i"))),
  ).toEqual([String(cell)]);
  expect(await notesTool.getAttribute("aria-pressed")).toBe("false");
  expect(await page.getByRole("button", { name: /^(ON|OFF) ?色$/ }).getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(await sounds()).toBe(afterSolved);

  await result.getByRole("button", { name: "次へ" }).click();
  await expect(page.locator(".bar-kicker")).toHaveText(`手筋の練習 · 2/${total}`);
  expect((await practicePosition(page, single)).id).toBe(single.positions[1].id);
  await expect(result).toHaveCount(0);

  // ブラウザの戻るで一覧へ。解いた数が増えている
  await page.goBack();
  await expect(practiceCount(page, single)).toHaveText(`1/${total}`);

  // 開き直すと、まだ解いていない局面から。最後の局面では一覧に戻る
  await openPracticeItem(page, single);
  for (let i = 1; i < total; i++) {
    await expect(page.locator(".bar-kicker")).toHaveText(`手筋の練習 · ${i + 1}/${total}`);
    const p = await practicePosition(page, single);
    const move = answerOf(p).placement!;
    await cells.nth(move.cell).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Digit${move.digit}`);
    await expect(result).toContainText("正解");
    await result.getByRole("button", { name: i < total - 1 ? "次へ" : "一覧に戻る" }).click();
  }
  await expect(practiceCount(page, single)).toHaveText(`${total}/${total}`);
  await expect(page.locator(".practice-row.is-done")).toHaveCount(1);
  await shot(page, "practice-list-done");

  // 再読み込みしても残る。ブラウザの戻るでホームへ
  await page.reload();
  await openPracticeList(page);
  await expect(practiceCount(page, single)).toHaveText(`${total}/${total}`);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();

  // 練習はフリープレイの保存と記録に触れず、練習の進み具合だけを保存する
  const after = await savedState(page);
  expect(after.free).toBe(before.free);
  expect(after.stats).toBe(before.stats);
  expect(after.keys).toEqual([...before.keys, "sudoku:practice"].sort());
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:practice")))!)).toEqual({
    "naked-single": single.positions.map((p) => p.id),
  });
});

test("手筋の練習：ヒントで手筋の名前→説明と消す候補の順に見せ、メモに反映すると正解になる", async ({
  page,
}) => {
  await page.goto("/");
  await openPracticeList(page);
  const item = practiceItem("x-wing");
  await openPracticeItem(page, item);
  await expect(page.locator(".practice-status")).toHaveText("消せる候補をメモから消す");
  const p = await practicePosition(page, item);
  const answer = answerOf(p);

  await page.getByRole("button", { name: "ヒント", exact: true }).click();
  const panel = page.locator(".hint-panel");
  await expect(panel.locator(".hint-title")).toHaveText(item.name);
  await expect(panel.locator(".hint-body")).toHaveCount(0);
  await panel.getByRole("button", { name: "もっと見る" }).click();
  await expect(panel.locator(".hint-body")).toBeVisible();
  const targets = [...new Set(answer.eliminations.map((e) => e.cell))].sort((a, b) => a - b);
  await expect(page.locator(".cell.hint-target")).toHaveCount(targets.length);
  expect(
    await page
      .locator(".cell.hint-target")
      .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-i")))),
  ).toEqual(targets);
  await shot(page, "practice-hint");

  await panel.getByRole("button", { name: "メモに反映" }).click();
  await expect(page.locator(".practice-result")).toContainText("正解");
  const cells = page.getByRole("gridcell");
  for (const { cell, digit } of answer.eliminations) {
    await expect(cells.nth(cell).locator(".notes .on").getByText(String(digit), { exact: true })).toHaveCount(
      0,
    );
  }
  await page.getByRole("button", { name: "一覧に戻る" }).first().click();
  await expect(practiceCount(page, item)).toHaveText(`1/${item.positions.length}`);
});

test("手筋の練習：狙いの手にならないヒントを反映しても正解にしない（正解の数字をメモから消したまま反映する、消しすぎて見つかった易しい手筋を反映する）", async ({
  page,
}) => {
  await page.goto("/");
  await openPracticeList(page);
  const item = practiceItem("x-wing");
  await openPracticeItem(page, item);
  const p = await practicePosition(page, item);
  const answer = answerOf(p);
  const notes = startNotes(p);
  const cells = page.getByRole("gridcell");
  const noteOf = (cell: number, digit: number) =>
    cells.nth(cell).locator(".notes .on").getByText(String(digit), { exact: true });
  const toggleNote = async (cell: number, digit: number) => {
    await cells.nth(cell).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Shift+Digit${digit}`);
  };
  const panel = page.locator(".hint-panel");
  /** ヒントを開き、手筋の名前を確かめてから説明に進み、盤面に反映する */
  const applyHint = async (title: string, button: string) => {
    await page.getByRole("button", { name: "ヒント", exact: true }).click();
    await expect(panel.locator(".hint-title")).toHaveText(title);
    await panel.getByRole("button", { name: "もっと見る" }).click();
    await panel.getByRole("button", { name: button }).click();
    await expect(panel).toHaveCount(0);
  };
  const result = page.locator(".practice-result");
  const problem = page.locator(".stuck-bar");
  const undo = page.getByRole("button", { name: "戻す", exact: true });

  // 狙いと関係なく、始めのメモが候補をすべて書いたまま（2 つ以上）のマス
  const other = notes.findIndex(
    (n, i) =>
      digitsOf(n).length >= 2 &&
      !answer.eliminations.some((e) => e.cell === i) &&
      !p.removed.some(([c]) => c === i),
  );
  expect(other).toBeGreaterThanOrEqual(0);
  const solution = p.solution[other];

  // 正解の数字をメモから消してから狙いの手筋のヒントを反映しても、消した数字は戻らないので正解にしない
  await toggleNote(other, solution);
  await expect(problem).toHaveText("正解の数字をメモから消しています");
  await applyHint(item.name, "メモに反映");
  for (const { cell, digit } of answer.eliminations) await expect(noteOf(cell, digit)).toHaveCount(0);
  await expect(noteOf(other, solution)).toHaveCount(0);
  await expect(problem).toHaveText("正解の数字をメモから消しています");
  await expect(cells.nth(other)).toHaveClass(/stuck/);
  await expect(result).toHaveCount(0);
  await undo.click();
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(problem).toHaveCount(0);

  // メモを正解の数字だけにすると、ヒントはそのマスに置くシングルになる。置いても狙いの手筋をしていないので正解にしない
  const extra = digitsOf(notes[other]).filter((d) => d !== solution);
  for (const d of extra) await toggleNote(other, d);
  await expect(cells.nth(other).locator(".notes .on")).toHaveText([String(solution)]);
  await applyHint("ネイキッドシングル", "置く");
  await expect(cells.nth(other)).toHaveAttribute("aria-label", new RegExp(` ${solution}$`));
  await expect(result).toHaveCount(0);
  await expect(problem).toHaveCount(0);
  for (let i = 0; i <= extra.length; i++) await undo.click();
  await expect(undo).toBeDisabled();

  // 狙いの手筋のヒントを反映すれば正解
  await applyHint(item.name, "メモに反映");
  await expect(result).toContainText("正解");
});

test("手筋の練習：消す手筋を手で解く。正解の数字を消すと誤りを示し、余計な候補を消しても正解になる。6 つ並びのバッジも掛からない", async ({
  page,
}) => {
  await page.goto("/");
  await openPracticeList(page);
  const item = practiceItem("naked-pair");
  await openPracticeItem(page, item);
  const p = await practicePosition(page, item);
  const answer = answerOf(p);
  const notes = startNotes(p);
  const cells = page.getByRole("gridcell");
  const toggleNote = async (cell: number, digit: number) => {
    await cells.nth(cell).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Shift+Digit${digit}`);
  };
  const problem = page.locator(".stuck-bar");

  // 正解の数字をメモから消すと、そのマスを赤い枠で示す。戻せば消える
  const [{ cell }] = answer.eliminations;
  await toggleNote(cell, p.solution[cell]);
  await expect(problem).toHaveText("正解の数字をメモから消しています");
  await expect(cells.nth(cell)).toHaveClass(/stuck/);
  await shot(page, "practice-lost");
  await page.getByRole("button", { name: "戻す", exact: true }).click();
  await expect(problem).toHaveCount(0);
  await expect(cells.nth(cell)).not.toHaveClass(/stuck/);

  // 狙いではなく正解でもない候補を消しても誤りにしない
  const extra = notes.flatMap((n, i) =>
    [1, 2, 3, 4, 5, 6, 7, 8, 9]
      .filter((d) => n & (1 << d) && d !== p.solution[i] && !answer.eliminations.some((e) => e.cell === i))
      .map((d) => ({ cell: i, digit: d })),
  )[0];
  await toggleNote(extra.cell, extra.digit);
  await expect(
    cells.nth(extra.cell).locator(".notes .on").getByText(String(extra.digit), { exact: true }),
  ).toHaveCount(0);
  await expect(problem).toHaveCount(0);
  await expect(page.locator(".practice-result")).toHaveCount(0);

  for (const e of answer.eliminations) await toggleNote(e.cell, e.digit);
  await expect(page.locator(".practice-result")).toContainText("正解");

  // 練習のツールは 6 つ並び。狭い画面でもバッジが隣のボタンに掛からない
  await expect(page.locator(".tools.is-dense .tool")).toHaveCount(6);
  for (const size of [
    { width: 320, height: 568 },
    { width: 393, height: 852 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForFunction((width) => window.innerWidth === width, size.width);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    expect(await toolBadgeProblems(page), `${size.width}x${size.height}`).toEqual({
      badges: 2,
      problems: [],
    });
    await shot(page, `practice-tools-${size.width}`);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot(page, "practice-dark");
});

/** ホームのヘッダーの「遊び方」（初回の案内にも同じ名前のリンクがある） */
const howtoButton = (page: Page) => page.getByRole("banner").getByRole("button", { name: "遊び方" });
/** ホームの初回の案内（iPhone ではホーム画面への追加の案内も note なので、文言で絞る） */
const howtoHint = (page: Page) => page.getByRole("note").filter({ hasText: "ルールと操作は" });

test("遊び方：ホームの入口で開き、Esc で閉じる。ルール・今日の一問の決まり・難易度と手筋・キー一覧がある", async ({
  page,
}) => {
  await page.goto("/");
  const howto = page.getByRole("dialog", { name: "遊び方" });
  await howtoButton(page).click();
  await expect(howto).toBeVisible();
  await expect(howto.getByRole("heading", { name: "ルール", exact: true })).toBeVisible();
  await expect(howto).toContainText("同じ数字を入れない");
  await expect(howto.getByRole("heading", { name: "今日の一問", exact: true })).toBeVisible();
  for (const text of [
    "難易度ごとに 1 日 1 問",
    "一時停止はできない",
    "ヒントと自動メモは使えない",
    "最初のクリアだけ",
  ])
    await expect(howto).toContainText(text);
  // 設定から移した難易度と手筋・キー一覧（キー一覧はマウスのある端末だけに出す）
  await expect(howto.getByRole("heading", { name: "難易度と手筋" })).toBeVisible();
  const levels = howto.locator("section", {
    has: page.getByRole("heading", { name: "難易度と手筋", exact: true }),
  });
  await expect(levels.locator("dt")).toHaveText([
    "かんたん",
    "ふつう",
    "むずかしい",
    "エキスパート",
    "鬼",
    "極",
  ]);
  const keys = howto.locator(".keys");
  await expect(keys).toContainText("Shift + Z");
  await expect(keys).toContainText("ヒント（今日の一問を除く）");
  // 見出しと一覧は同じ条件で出し入れする（条件の判定は環境で変わり得るので、ページで測る）
  const fine = await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches);
  for (const el of [keys, howto.getByRole("heading", { name: "キーボード" })])
    await (fine ? expect(el).toBeVisible() : expect(el).toBeHidden());
  if (SHOTS) {
    // シートが止まってから、上と下を撮る
    await howto.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
    await shot(page, "howto");
    await howto
      .locator(".sheet")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight, behavior: "instant" }));
    await shot(page, "howto-bottom");
  }

  await page.keyboard.press("Escape");
  await expect(howto).toBeHidden();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
});

test("設定シートから遊び方へ移る。設定シートに難易度と手筋・キー一覧は無い。ゲーム中は「練習してみる」を出さない", async ({
  page,
}) => {
  await page.goto("/");
  const settings = page.getByRole("dialog", { name: "設定" });
  const howto = page.getByRole("dialog", { name: "遊び方" });
  await page.getByRole("button", { name: "設定" }).click();
  await expect(settings).toBeVisible();
  await expect(settings).not.toContainText("難易度と手筋");
  await expect(settings).not.toContainText("Shift + Z");
  // 難易度と手筋・キー一覧はどちらも定義リスト
  await expect(settings.locator("dl")).toHaveCount(0);
  await settings.getByRole("button", { name: "遊び方" }).click();
  await expect(settings).toBeHidden();
  await expect(howto).toBeVisible();
  await expect(howto.getByRole("button", { name: "練習してみる" })).toBeVisible();
  await howto.getByRole("button", { name: "閉じる" }).click();
  await expect(howto).toBeHidden();

  // ゲームの設定からも開ける。戻る操作で一覧を通らなくなるので、練習へは移らない
  await page.locator(".free-easy").click();
  const board = page.getByRole("grid", { name: "ナンプレの盤面" });
  await expect(board).toBeVisible();
  await page.getByRole("button", { name: "設定" }).click();
  await settings.getByRole("button", { name: "遊び方" }).click();
  await expect(howto).toBeVisible();
  await expect(howto.getByRole("button", { name: "練習してみる" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(howto).toBeHidden();
  await expect(board).toBeVisible();
});

test("遊び方の「練習してみる」でネイキッドシングルの練習が開く。ブラウザの戻るで一覧、もう一度でホーム", async ({
  page,
}) => {
  await page.goto("/");
  const howto = page.getByRole("dialog", { name: "遊び方" });
  const single = practiceItem("naked-single");
  // 1 回目は局面のデータを読み込んでから、2 回目は読み込み済みのデータで開く
  for (let round = 0; round < 2; round++) {
    await howtoButton(page).click();
    await howto.getByRole("button", { name: "練習してみる" }).click();
    await expect(howto).toBeHidden();
    await expect(page.getByRole("heading", { name: single.name })).toBeVisible();
    await expect(page.locator(".bar-kicker")).toHaveText(`手筋の練習 · 1/${single.positions.length}`);
    await page.goBack();
    await expect(page.locator(".practice-row")).toHaveCount(PRACTICE.length);
    await page.goBack();
    await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  }
});

test("初回の案内：閉じると、再読み込みしても出ない", async ({ page }) => {
  await page.goto("/");
  const hint = howtoHint(page);
  await expect(hint).toBeVisible();
  await shot(page, "howto-hint");
  // 出しただけでは保存しない
  expect(await page.evaluate(() => localStorage.getItem("sudoku:howto"))).toBeNull();
  await hint.getByRole("button", { name: "閉じる" }).click();
  await expect(hint).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("初回の案内：案内の「遊び方」やヘッダーから遊び方を開いても、それ以降は出さない", async ({ page }) => {
  await page.goto("/");
  const hint = howtoHint(page);
  const howto = page.getByRole("dialog", { name: "遊び方" });
  await hint.getByRole("button", { name: "遊び方" }).click();
  await expect(howto).toBeVisible();
  await expect(hint).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(howto).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await expect(hint).toHaveCount(0);

  // 案内が出ている状態から、ヘッダーで開いても消える
  await page.evaluate(() => localStorage.removeItem("sudoku:howto"));
  await page.reload();
  await expect(hint).toBeVisible();
  await howtoButton(page).click();
  await expect(howto).toBeVisible();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await expect(hint).toHaveCount(0);
});

test("ホーム：幅 320px でも見出しが 1 行に収まり、ヘッダーのアイコンが画面からはみ出さない", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/");
  const title = page.getByRole("heading", { name: "ナンプレ" });
  await expect(title).toBeVisible();
  // 文字の矩形の上端がそろっていれば 1 行（1 行の高さはフォントで変わるので、高さでは測らない）
  const tops = await title.evaluate((h) => {
    const range = document.createRange();
    range.selectNodeContents(h);
    return [...range.getClientRects()].map((r) => r.top);
  });
  expect(tops.length).toBeGreaterThan(0);
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(10);
  const settings = await page.getByRole("banner").getByRole("button", { name: "設定" }).boundingBox();
  expect(settings!.x + settings!.width).toBeLessThanOrEqual(320);
});

/** 記録画面の実績のカードと、名前が name の実績の行 */
const achievementCard = (page: Page) => page.getByRole("region", { name: "実績", exact: true });
const achievementItem = (page: Page, name: string) =>
  achievementCard(page)
    .getByRole("listitem")
    .filter({ has: page.getByText(name, { exact: true }) });
const doneMark = (item: Locator) => item.getByRole("img", { name: "達成済み" });
/** 記録画面の実績のカードに「n / 全体の数」と出ている */
const expectAchievementCount = (page: Page, n: number) =>
  expect(achievementCard(page).getByText(new RegExp(`^${n} / \\d+$`))).toBeVisible();

/** 要素の右端が幅 width の画面に収まっている */
async function expectWithin(locator: Locator, width: number) {
  const box = await locator.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
}

/**
 * 記録の日付を読めなくして、実績の判定だけが例外を投げるようにする（日付の計算で RangeError になる）。
 * 起動時の判定は通してから、クリアの直前に呼ぶ。ホームの連続日数も同じ計算を使うので、戻る前に restore する
 */
async function breakDateParsing(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __parse: typeof Date.parse };
    w.__parse = Date.parse;
    Date.parse = () => Number.NaN;
  });
  return () =>
    page.evaluate(() => {
      Date.parse = (window as unknown as { __parse: typeof Date.parse }).__parse;
    });
}

test("実績：今日の一問を解くと結果に「実績: 初めてのクリア」が出て、記録画面で達成済みになる。再読み込みしても二重に出ない", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.goto("/");
  // 記録画面に実績のカードがあり、まだ何も解除していない
  await page.getByRole("button", { name: "記録" }).click();
  const card = achievementCard(page);
  await expect(card.getByRole("heading", { name: "実績" })).toBeVisible();
  await expectAchievementCount(page, 0);
  const first = achievementItem(page, "初めてのクリア");
  await expect(first).toContainText("今日の一問を1問クリア");
  await expect(doneMark(first)).toHaveCount(0);
  await page.getByRole("button", { name: "戻る", exact: true }).click();

  await page.locator(".daily-row").first().click();
  await page.getByPlaceholder("ニックネーム").fill(`実績${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  const solution = solve(g.puzzle)!;
  const last = await fill(page, g.puzzle, solution, true);
  // サーバーは 15 秒未満のクリアを受け付けない
  await page.waitForTimeout(15_500);
  await page
    .getByRole("gridcell")
    .nth(last)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${solution[last]}`);
  const result = page.getByRole("dialog", { name: "クリア" });
  // 端末に結果を保存した時点で判定する
  await expect(result.getByText("実績: 初めてのクリア", { exact: true })).toBeVisible({ timeout: 10_000 });
  await shot(page, "result-achievement");

  await result.getByRole("button", { name: "ホーム", exact: true }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expectAchievementCount(page, 1);
  await expect(doneMark(first)).toBeVisible();
  await expect(first).toContainText(/\d{4}\/\d{1,2}\/\d{1,2}/);
  await expect(doneMark(achievementItem(page, "3日連続"))).toHaveCount(0);
  await shot(page, "records-achievements");

  // 再読み込みして解いた問題を開き直しても、実績は達成済みのままで、結果に二度は出さない
  await page.reload();
  await page.locator(".daily-row").first().click();
  await expect(result.getByText(/位/).first()).toBeVisible({ timeout: 10_000 });
  await expect(result.getByText(/^実績:/)).toHaveCount(0);
  await result.getByRole("button", { name: "ホーム", exact: true }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expectAchievementCount(page, 1);
  await expect(doneMark(first)).toBeVisible();
});

test("実績：フリープレイの合計 100 問目をヒントもミスもなしで解くと 2 つ解除する。壊れた保存データでも落ちず、幅 320px でもはみ出さない", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    // 再読み込みでは入れ直さない
    if (localStorage.getItem("sudoku:stats")) return;
    localStorage.setItem(
      "sudoku:stats",
      JSON.stringify({ easy: { played: 99, bestMs: 60_000, cleanBestMs: null, bestPoints: 100 }, junk: 1 }),
    );
    // 知らない実績や日付でない値は捨てる
    localStorage.setItem(
      "sudoku:achievements",
      JSON.stringify({ "daily-first": 123, "free-all": "2026-02-30", unknown: "2026-10-01" }),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "記録" }).click();
  const card = achievementCard(page);
  await expectAchievementCount(page, 0);
  await page.getByRole("button", { name: "戻る", exact: true }).click();

  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  await fill(page, g.puzzle, g.solution!);
  const result = page.getByRole("dialog", { name: "クリア" });
  const line = result.getByText("実績: ノーミスクリア、100問クリア", { exact: true });
  await expect(line).toBeVisible();
  await expectWithin(line, 320);
  await shot(page, "result-achievement-320");

  await result.getByRole("button", { name: "ホーム", exact: true }).click();
  await page.getByRole("button", { name: "記録" }).click();
  await expectAchievementCount(page, 2);
  for (const name of ["ノーミスクリア", "100問クリア"])
    await expect(doneMark(achievementItem(page, name))).toBeVisible();
  for (const name of ["初めてのクリア", "全難易度クリア"])
    await expect(doneMark(achievementItem(page, name))).toHaveCount(0);
  // カードの中身が横にはみ出さない
  await card.scrollIntoViewIfNeeded();
  await expectWithin(card, 320);
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await shot(page, "records-achievements-320");
  const saved = JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:achievements")))!);
  expect(Object.keys(saved).sort()).toEqual(["free-100", "free-clean"]);

  // 再読み込みしても達成済みのまま
  await page.reload();
  await page.getByRole("button", { name: "記録" }).click();
  await expectAchievementCount(page, 2);
});

test("実績：手筋の練習で最後に残った手筋を解くと、正解の欄に「実績: 全手筋の練習」を 1 回だけ出す", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const single = practiceItem("naked-single");
  // ネイキッドシングル以外は 1 局面ずつ解いてある
  const progress = Object.fromEntries(
    PRACTICE.filter((item) => item !== single).map((item) => [item.key, [item.positions[0].id]]),
  );
  await page.addInitScript((p) => {
    if (!localStorage.getItem("sudoku:practice")) localStorage.setItem("sudoku:practice", p);
  }, JSON.stringify(progress));
  await page.goto("/");
  await openPracticeList(page);
  await openPracticeItem(page, single);
  const result = page.locator(".practice-result");
  const solveShown = async () => {
    const move = answerOf(await practicePosition(page, single)).placement!;
    await page
      .getByRole("gridcell")
      .nth(move.cell)
      .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Digit${move.digit}`);
    await expect(result).toContainText("正解");
  };
  await solveShown();
  const line = result.getByText("実績: 全手筋の練習", { exact: true });
  await expect(line).toBeVisible();
  await expectWithin(line, 320);
  await shot(page, "practice-achievement-320");

  // 次の局面を解いても、もう出さない
  await result.getByRole("button", { name: "次へ" }).click();
  await solveShown();
  await nextFrames(page);
  await expect(result.getByText(/^実績:/)).toHaveCount(0);
});

test("実績：端末の結果に日付でない記録や年が 1000 未満の記録が混じっていても、ホームと記録画面が落ちない。前からの達成は日付なしで解除済みにする", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // 年が 4 桁にそろっていない日付は Chromium で読めず、起動時の判定で落ちていた（WebKit は読める）
    for (const date of ["2026-10-01", "0x", "0001-01-01", "0999-05-01"]) {
      localStorage.setItem(
        `sudoku:result:${date}:easy`,
        JSON.stringify({ date, difficulty: "easy", timeMs: 60_000, points: 100, rank: 1, total: 1 }),
      );
    }
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
  await page.getByRole("button", { name: "記録" }).click();
  await expect(metric(page, "今日の一問", "クリア数")).toHaveText("1");
  const first = achievementItem(page, "初めてのクリア");
  await expect(doneMark(first)).toBeVisible();
  await expect(first).not.toContainText(/\d{4}\//);
  await expectAchievementCount(page, 1);
});

test("実績：判定が例外を投げても、フリープレイのクリアを記録して結果を出す", async ({ page }) => {
  // 起動時に裏で取る履歴は、届くとホームの連続日数を計算し直す（判定と違って例外を受けない）ので、届いてから日付を壊す
  const history = page.waitForResponse((r) => r.url().includes("/api/player/history"));
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const last = await fill(page, g.puzzle, g.solution!, true);
  await history;
  await nextFrames(page);
  const restore = await breakDateParsing(page);
  await page
    .getByRole("gridcell")
    .nth(last)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${g.solution![last]}`);
  const result = page.getByRole("dialog", { name: "クリア" });
  await expect(result.getByText("自己ベスト更新")).toBeVisible();
  await expect(result.getByText(/^実績:/)).toHaveCount(0);
  const stats = JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:stats")))!);
  expect(stats.easy.played).toBe(1);
  await restore();
  await result.getByRole("button", { name: "ホーム", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ナンプレ" })).toBeVisible();
});

test("実績：判定が例外を投げても、今日の一問の送信は成功として順位を出す（再送信にしない）", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await page.locator(".daily-row").first().click();
  await page.getByPlaceholder("ニックネーム").fill(`判定${info.project.name}`);
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByLabel("ランキング戦")).toBeVisible();
  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  const solution = solve(g.puzzle)!;
  const last = await fill(page, g.puzzle, solution, true);
  // サーバーは 15 秒未満のクリアを受け付けない
  await page.waitForTimeout(15_500);
  let submits = 0;
  page.on("request", (r) => {
    if (r.url().includes("/api/daily/submit")) submits++;
  });
  const restore = await breakDateParsing(page);
  await page
    .getByRole("gridcell")
    .nth(last)
    .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  await page.keyboard.press(`Digit${solution[last]}`);
  const result = page.getByRole("dialog", { name: "クリア" });
  await expect(result.getByText(/位/).first()).toBeVisible({ timeout: 10_000 });
  await expect(result.getByRole("button", { name: /再送信/ })).toHaveCount(0);
  await expect(result.getByText(/^実績:/)).toHaveCount(0);
  const saved = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith("sudoku:result:")),
  );
  expect(saved).toHaveLength(1);
  // クリアの処理は 1 回だけ（描き直しで判定の関数が変わっても送り直さない）
  await nextFrames(page);
  expect(submits).toBe(1);
  await restore();
});

/** 毎日の通知のテストで使うプレイヤーと公開鍵（P-256 の点を未圧縮で表した 65 バイト） */
const PUSH_PLAYER = "55555555-5555-4555-8555-555555555555";
const PUSH_PUBLIC_KEY = createECDH("prime256v1").generateKeys().toString("base64url");
/** 偽の購読の endpoint と toJSON()（fakePush で n 番目に作る購読） */
const fakeEndpoint = (n: number) => `https://fcm.googleapis.com/fcm/send/e2e-${n}`;
const fakeSubscription = (n: number) => ({
  endpoint: fakeEndpoint(n),
  expirationTime: null,
  keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" },
});

/** 設定シートの「毎日の通知」のトグル */
const reminderToggle = (page: Page) =>
  page.getByRole("dialog", { name: "設定" }).getByRole("checkbox", { name: /毎日の通知/ });

/**
 * 通知の API（Service Worker の登録・購読・Notification）を偽物に置き換える。実際の購読・プッシュサービスへの接続はしない。
 * iPhone でも使える端末として扱うよう、ホーム画面に追加したアプリとして開いていることにする。
 * permission は初めの許可、grant は許可を求めたときの答え、subscribed は購読が残っているか、reminder は有効にした印。
 * 購読は、実際のブラウザと同じく userVisibleOnly が true でないと作らず、鍵が公開鍵のバイト列でなければ作らない。
 * 許可を求めた・購読した・外した回数は window.__push に残す。
 * host があれば、プレイヤーと有効にした印はそのホスト名の URL にだけ入れる（API の偽物はどの URL でも使う）。
 * once なら、それらはそのタブで最初に開いたときだけ入れる（読み込み直しても入れ直さない）
 */
async function fakePush(
  page: Page,
  opts: {
    permission?: NotificationPermission;
    grant?: NotificationPermission;
    subscribed?: boolean;
    reminder?: boolean;
    host?: string;
    once?: boolean;
  } = {},
) {
  await page.addInitScript(
    ({ o, player, publicKey }) => {
      if (
        (!o.host || location.hostname === o.host) &&
        !(o.once && sessionStorage.getItem("e2e:push-seeded"))
      ) {
        localStorage.setItem("sudoku:player", JSON.stringify({ id: player, name: "通知" }));
        if (o.reminder) localStorage.setItem("sudoku:reminder", "true");
        if (o.once) sessionStorage.setItem("e2e:push-seeded", "1");
      }
      const log = { requested: 0, subscribe: 0, unsubscribe: 0 };
      (window as unknown as { __push: typeof log }).__push = log;
      let permission: NotificationPermission = o.permission ?? "default";
      let made = 0;
      type Sub = {
        endpoint: string;
        options: { applicationServerKey: ArrayBuffer | null };
        toJSON: () => unknown;
        unsubscribe: () => Promise<boolean>;
      };
      let current: Sub | null = null;
      const make = (key: ArrayBuffer | null): Sub => {
        const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-${made++}`;
        const sub: Sub = {
          endpoint,
          options: { applicationServerKey: key },
          toJSON: () => ({
            endpoint,
            expirationTime: null,
            keys: { p256dh: "e2e-p256dh", auth: "e2e-auth" },
          }),
          unsubscribe: async () => {
            log.unsubscribe++;
            if (current === sub) current = null;
            return true;
          },
        };
        return sub;
      };
      if (o.subscribed) current = make(null);
      const expected = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0),
      );
      const reg = {
        active: {},
        pushManager: {
          getSubscription: async () => current,
          subscribe: async (init: PushSubscriptionOptionsInit) => {
            log.subscribe++;
            const key = init.applicationServerKey;
            if (
              init.userVisibleOnly !== true ||
              !(key instanceof Uint8Array) ||
              key.length !== expected.length ||
              key.some((b, i) => b !== expected[i])
            ) {
              throw new DOMException("invalid subscribe options", "NotAllowedError");
            }
            current ??= make(new Uint8Array(key).buffer);
            return current;
          },
        },
      };
      const define = (target: object, key: string, value: unknown) =>
        Object.defineProperty(target, key, { configurable: true, writable: true, value });
      define(navigator, "serviceWorker", {
        register: async () => reg,
        getRegistration: async () => reg,
        ready: Promise.resolve(reg),
      });
      define(navigator, "standalone", true);
      define(window, "PushManager", function PushManager() {});
      const FakeNotification = function Notification() {};
      Object.defineProperty(FakeNotification, "permission", { get: () => permission });
      define(FakeNotification, "requestPermission", async () => {
        log.requested++;
        permission = o.grant ?? "granted";
        return permission;
      });
      define(window, "Notification", FakeNotification);
    },
    { o: opts, player: PUSH_PLAYER, publicKey: PUSH_PUBLIC_KEY },
  );
  return () => page.evaluate(() => (window as unknown as { __push: Record<string, number> }).__push);
}

/**
 * /api/push を偽のサーバーにする。GET は公開鍵、POST・DELETE は statuses の順に返す（最後の値はその後も返す）。
 * POST・DELETE で送った本文を、受けた時点で記録する。hold があれば、POST・DELETE の応答をそれが解決するまで待たせる
 */
async function routePush(
  page: Page,
  statuses: { POST?: number[]; DELETE?: number[]; hold?: Promise<void> } = {},
) {
  const sent: { method: string; body: unknown }[] = [];
  await page.route("**/api/push", async (route) => {
    const req = route.request();
    const method = req.method();
    if (method === "GET") return route.fulfill({ json: { publicKey: PUSH_PUBLIC_KEY } });
    sent.push({ method, body: req.postDataJSON() });
    await statuses.hold;
    const queue = statuses[method as "POST" | "DELETE"] ?? [200];
    const status = queue.length > 1 ? queue.shift()! : queue[0];
    await route.fulfill({ status, json: status === 200 ? { ok: true } : { error: "error" } });
  });
  return sent;
}

/** /api/push への method の応答か（page.waitForResponse に渡す） */
const isPushApi = (method: string) => (r: Response) =>
  new URL(r.url()).pathname === "/api/push" && r.request().method() === method;

const reminderFlag = (page: Page) => page.evaluate(() => localStorage.getItem("sudoku:reminder"));

/** 通知の項目を見える位置に出し、シートとトグルの動きが止まってから撮る */
async function reminderShot(page: Page, name: string) {
  if (!SHOTS) return;
  await reminderToggle(page).scrollIntoViewIfNeeded();
  await page
    .getByRole("dialog", { name: "設定" })
    .evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await shot(page, name);
}

test.describe("毎日の通知", () => {
  // 本物の Service Worker が登録されると、page.route で応答を差し替えられないことがある
  test.use({ serviceWorkers: "block" });

  test("サーバーに通知の設定が無ければ（503）項目を出さない。公開鍵を返すようになれば、次に開いたときに出す", async ({
    page,
  }) => {
    let available = false;
    let gets = 0;
    await page.route("**/api/push", (route) => {
      gets++;
      return available
        ? route.fulfill({ json: { publicKey: PUSH_PUBLIC_KEY } })
        : route.fulfill({ status: 503, json: { error: "push unavailable" } });
    });
    await page.goto("/");
    const settings = page.getByRole("dialog", { name: "設定" });
    const got = page.waitForResponse(isPushApi("GET"));
    await page.getByRole("button", { name: "設定" }).click();
    expect((await got).status()).toBe(503);
    await nextFrames(page);
    await expect(settings.getByRole("checkbox", { name: "ヒントの前に確認" })).toBeVisible();
    await expect(settings.getByText("毎日の通知")).toHaveCount(0);
    await expect(settings.getByRole("heading", { name: "通知", exact: true })).toHaveCount(0);
    await settings.getByRole("button", { name: "閉じる" }).click();
    await expect(settings).toBeHidden();

    // 取れなかったときは、次に開いたときに取り直す（端末によって押せるかは違うので、項目があることだけ見る）
    available = true;
    await page.getByRole("button", { name: "設定" }).click();
    await expect(reminderToggle(page)).toBeVisible();
    await expect(settings.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
    expect(gets).toBe(2);
    await reminderShot(page, "settings-reminder");
  });

  test("iPhone の Safari のページでは、ホーム画面に追加したアプリで設定できることを示し、押せない", async ({
    page,
  }, info) => {
    test.skip(!isIphone(info), "iPhone の Safari だけ");
    await routePush(page);
    await page.goto("/");
    await page.getByRole("button", { name: "設定" }).click();
    const toggle = reminderToggle(page);
    await expect(toggle).toBeDisabled();
    await expect(toggle).not.toBeChecked();
    await expect(
      page.getByRole("dialog", { name: "設定" }).getByText("ホーム画面に追加したアプリで設定できます"),
    ).toBeVisible();
  });

  test("通知の許可がブロックされていれば、そのことを示し、押せない", async ({ page }) => {
    const pushLog = await fakePush(page, { permission: "denied" });
    const sent = await routePush(page);
    await page.goto("/");
    await page.getByRole("button", { name: "設定" }).click();
    const toggle = reminderToggle(page);
    await expect(toggle).toBeDisabled();
    await expect(
      page.getByRole("dialog", { name: "設定" }).getByText("通知が許可されていません"),
    ).toBeVisible();
    expect(await pushLog()).toEqual({ requested: 0, subscribe: 0, unsubscribe: 0 });
    expect(sent).toEqual([]);
  });

  test("有効にすると許可 → 購読 → 登録して印を保存する。無効にするとサーバーから消し、購読と印を外す。続けて押しても 1 回だけ", async ({
    page,
  }) => {
    const pushLog = await fakePush(page, { permission: "default", grant: "granted" });
    const sent = await routePush(page);
    await page.goto("/");
    const settings = page.getByRole("dialog", { name: "設定" });
    await page.getByRole("button", { name: "設定" }).click();
    const toggle = reminderToggle(page);
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    await expect(
      settings.getByText("今日の一問を 1 問もクリアしていない日の 20 時（日本時間）"),
    ).toBeVisible();

    // 続けて 2 回押しても、操作は 1 回だけ（1 回目で押せなくなる）
    const pressTwice = () =>
      toggle.evaluate((el: HTMLElement) => {
        el.click();
        el.click();
      });
    const posted = page.waitForResponse(isPushApi("POST"));
    await pressTwice();
    await posted;
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await nextFrames(page);
    expect(sent).toEqual([
      { method: "POST", body: { playerId: PUSH_PLAYER, subscription: fakeSubscription(0) } },
    ]);
    expect(await reminderFlag(page)).toBe("true");
    expect(await pushLog()).toEqual({ requested: 1, subscribe: 1, unsubscribe: 0 });
    await reminderShot(page, "settings-reminder-on");

    // 開き直しても有効のまま
    await settings.getByRole("button", { name: "閉じる" }).click();
    await expect(settings).toBeHidden();
    await page.getByRole("button", { name: "設定" }).click();
    await expect(toggle).toBeChecked();

    const deleted = page.waitForResponse(isPushApi("DELETE"));
    await pressTwice();
    await deleted;
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    await nextFrames(page);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ method: "DELETE", body: { playerId: PUSH_PLAYER, endpoint: fakeEndpoint(0) } });
    expect(await reminderFlag(page)).toBeNull();
    expect(await pushLog()).toEqual({ requested: 1, subscribe: 1, unsubscribe: 1 });
  });

  test("有効にしている途中でシートを閉じて開き直すと、終わるまで項目を出さず（押せず）、終われば有効と示す", async ({
    page,
  }) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const pushLog = await fakePush(page, { permission: "default", grant: "granted" });
    const sent = await routePush(page, { hold });
    await page.goto("/");
    const settings = page.getByRole("dialog", { name: "設定" });
    await page.getByRole("button", { name: "設定" }).click();
    const toggle = reminderToggle(page);
    await toggle.click();
    // 登録の応答を待たせている間に閉じて開き直す
    await expect.poll(() => sent.length).toBe(1);
    await expect(toggle).toBeDisabled();
    await settings.getByRole("button", { name: "閉じる" }).click();
    await expect(settings).toBeHidden();
    await page.getByRole("button", { name: "設定" }).click();
    await expect(settings.getByRole("checkbox", { name: "ヒントの前に確認" })).toBeVisible();
    await nextFrames(page);
    await expect(toggle).toHaveCount(0);

    release();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    expect(sent).toEqual([
      { method: "POST", body: { playerId: PUSH_PLAYER, subscription: fakeSubscription(0) } },
    ]);
    expect(await reminderFlag(page)).toBe("true");
    expect(await pushLog()).toEqual({ requested: 1, subscribe: 1, unsubscribe: 0 });
  });

  test("登録できなければ（429・400）短い失敗を示し、購読と印を外す", async ({ page }) => {
    const pushLog = await fakePush(page, { permission: "default", grant: "granted" });
    const sent = await routePush(page, { POST: [429, 400] });
    await page.goto("/");
    const settings = page.getByRole("dialog", { name: "設定" });
    await page.getByRole("button", { name: "設定" }).click();
    const toggle = reminderToggle(page);

    await toggle.click();
    await expect(settings.getByText("しばらくしてからもう一度試してください")).toBeVisible();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    expect(await reminderFlag(page)).toBeNull();
    expect(await pushLog()).toEqual({ requested: 1, subscribe: 1, unsubscribe: 1 });
    await reminderShot(page, "settings-reminder-failed");

    await toggle.click();
    await expect(settings.getByText("設定できませんでした")).toBeVisible();
    await expect(settings.getByText("しばらくしてからもう一度試してください")).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    expect(await reminderFlag(page)).toBeNull();
    expect(await pushLog()).toEqual({ requested: 2, subscribe: 2, unsubscribe: 2 });
    expect(sent.map((s) => s.method)).toEqual(["POST", "POST"]);
  });

  test("有効にした端末は、開いたときに購読を登録し直す。引き継ぎでプレイヤーが変わると、新しいプレイヤーで登録し直す", async ({
    page,
  }) => {
    await fakePush(page, { permission: "granted", subscribed: true, reminder: true });
    const sent = await routePush(page);
    const next = "66666666-6666-4666-8666-666666666666";
    await page.route("**/api/player/claim", (route) =>
      route.fulfill({ json: { playerId: next, name: "引き継ぎ先", stats: null } }),
    );
    const posted = page.waitForResponse(isPushApi("POST"));
    await page.goto("/");
    await posted;
    expect(sent).toEqual([
      { method: "POST", body: { playerId: PUSH_PLAYER, subscription: fakeSubscription(0) } },
    ]);
    await page.getByRole("button", { name: "設定" }).click();
    await expect(reminderToggle(page)).toBeChecked();

    const moved = page.waitForResponse(isPushApi("POST"));
    const settings = page.getByRole("dialog", { name: "設定" });
    await settings.getByRole("button", { name: "コードを入力" }).click();
    await settings.getByLabel("引き継ぎコード").fill("ABCD-EFGH");
    await settings.getByRole("button", { name: "引き継ぐ" }).click();
    await expect(settings.getByText("引き継ぎました")).toBeVisible();
    await moved;
    expect(sent).toEqual([
      { method: "POST", body: { playerId: PUSH_PLAYER, subscription: fakeSubscription(0) } },
      { method: "POST", body: { playerId: next, subscription: fakeSubscription(0) } },
    ]);
    expect(await reminderFlag(page)).toBe("true");
  });

  test("有効にした印があっても購読が消えていたら、開いたときに印を外し、無効と示す", async ({ page }) => {
    await fakePush(page, { permission: "granted", subscribed: false, reminder: true });
    const sent = await routePush(page);
    await page.goto("/");
    await expect.poll(() => reminderFlag(page)).toBeNull();
    await page.getByRole("button", { name: "設定" }).click();
    const toggle = reminderToggle(page);
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    expect(sent).toEqual([]);
  });
});

/** 共有の URL で開く盤面（解が 1 つで、手筋のレベル 6。鬼・極） */
const SHARED_PUZZLE = "100006004060000000200000078000800000074000100500302040800000009001000020000760001";
const gridOf = (p: string) => [...p].map(Number);
/** 共有の URL で開いたときに、始めるかを確かめるシート */
const sharedSheet = (page: Page) => page.getByRole("dialog", { name: "共有された問題を始めますか？" });

test.describe("共有した盤面", () => {
  test.skip(({ browserName }) => browserName !== "chromium", "デスクトップだけ");

  const board = (page: Page) => page.getByRole("grid", { name: "ナンプレの盤面" });
  const storedStats = async (page: Page) =>
    JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:stats"))) ?? "{}");

  test("URL の盤面は、確かめるシートで始めるを押したときだけフリープレイとして始める。やめると何も変えない。URL から盤面を消す", async ({
    page,
    baseURL,
  }) => {
    const confirm = sharedSheet(page);
    await page.goto(`/?from=e2e&p=${SHARED_PUZZLE}&d=extreme`);
    await expect(confirm).toBeVisible();
    await expect(confirm.getByText("極のフリープレイとして始めます。", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/?from=e2e`);
    await confirm.getByRole("button", { name: "やめる", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(board(page)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("sudoku:free"))).toBeNull();
    expect((await storedStats(page)).extreme).toBeUndefined();

    await page.goto(`/?from=e2e&p=${SHARED_PUZZLE}&d=extreme`);
    await confirm.getByRole("button", { name: "始める", exact: true }).click();
    await expect(board(page)).toBeVisible();
    await expect(page.locator(".bar-main")).toHaveText("極");
    await expect(page).toHaveURL(`${baseURL}/?from=e2e`);
    const g = await savedGame(page, "sudoku:free");
    expect(g.puzzle).toEqual(gridOf(SHARED_PUZZLE));
    expect(g.solution).toEqual(solve(gridOf(SHARED_PUZZLE)));
    await expect(page.getByRole("gridcell").nth(0)).toHaveAccessibleName("1行1列 最初から 1");
    await expect(page.getByRole("gridcell").nth(1)).toHaveAccessibleName("1行2列 空き");
    expect((await storedStats(page)).extreme.started).toBe(1);

    // ホームに戻っても、URL に盤面は戻らない
    await page.getByRole("button", { name: "ホームに戻る" }).click();
    await expect(page.getByRole("heading", { name: "ナンプレ", exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/?from=e2e`);
  });

  test("読めない盤面では、ホームに知らせて始めない。URL から盤面を消す。ゲームを開くと知らせは消える", async ({
    page,
    baseURL,
  }) => {
    const notice = page.getByText("読み込めない盤面です", { exact: true });
    // 形が違う・解が 2 つ以上
    const multiple = `00${"530070000600195000098000060800060003400803001700020006060000280000419005000080079".slice(2)}`;
    for (const p of ["123", multiple]) {
      await page.goto(`/?p=${p}&d=easy`);
      await expect(notice, p).toBeVisible();
      await expect(page).toHaveURL(`${baseURL}/`);
      await expect(board(page)).toHaveCount(0);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await page.evaluate(() => localStorage.getItem("sudoku:free"))).toBeNull();
    }
    await page.locator(".free-easy").click();
    await expect(board(page)).toBeVisible();
    await page.getByRole("button", { name: "ホームに戻る" }).click();
    await expect(page.getByRole("heading", { name: "ナンプレ", exact: true })).toBeVisible();
    await expect(notice).toHaveCount(0);
  });

  test("途中のフリープレイがあれば、消えることを示して確かめる。やめると途中の問題が残る", async ({
    page,
    baseURL,
  }) => {
    await page.goto("/");
    await page.locator(".free-easy").click();
    await expect(board(page)).toBeVisible();
    const before = await savedGame(page, "sudoku:free");
    const first = before.puzzle.indexOf(0);
    await page
      .getByRole("gridcell")
      .nth(first)
      .dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
    await page.keyboard.press(`Digit${before.solution![first]}`);
    await expect.poll(async () => (await savedGame(page, "sudoku:free")).history.length).toBe(1);

    await page.goto(`/?p=${SHARED_PUZZLE}`);
    const confirm = sharedSheet(page);
    await expect(confirm).toBeVisible();
    await expect(
      confirm.getByText("鬼のフリープレイとして始めます。途中のフリープレイは消えます。", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/`);
    await confirm.getByRole("button", { name: "やめる", exact: true }).click();
    await expect(confirm).toBeHidden();
    expect((await savedGame(page, "sudoku:free")).puzzle).toEqual(before.puzzle);
    expect((await storedStats(page)).master).toBeUndefined();

    await page.goto(`/?p=${SHARED_PUZZLE}`);
    await confirm.getByRole("button", { name: "始める", exact: true }).click();
    await expect(board(page)).toBeVisible();
    await expect(page.locator(".bar-main")).toHaveText("鬼");
    expect((await savedGame(page, "sudoku:free")).puzzle).toEqual(gridOf(SHARED_PUZZLE));
    const stats = await storedStats(page);
    expect(stats.easy.started).toBe(1);
    expect(stats.master.started).toBe(1);
  });

  test("フリープレイの結果を共有すると、同じ盤面を開く URL を文に入れてコピーする", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    // 共有のシートを使わず、コピーにする
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true }),
    );
    // 完成した盤面から 4 マスを空けた問題（かんたん）
    const solution = solve(gridOf(SHARED_PUZZLE))!;
    const puzzle = solution.map((v, i) => ([0, 10, 40, 80].includes(i) ? 0 : v));
    const p = puzzle.join("");
    await page.goto(`/?p=${p}`);
    await sharedSheet(page).getByRole("button", { name: "始める", exact: true }).click();
    await expect(board(page)).toBeVisible();
    await fill(page, puzzle, solution);
    const result = page.getByRole("dialog", { name: "クリア" });
    await expect(result).toBeVisible();
    await result.getByRole("button", { name: "結果を共有", exact: true }).click();
    await expect(result.getByRole("button", { name: "コピーしました", exact: true })).toBeVisible();
    const [text, url] = (await page.evaluate(() => navigator.clipboard.readText())).split("\n");
    expect(text).toMatch(/^ナンプレ（かんたん） [\d,]+点（\d{2}:\d{2}）$/);
    expect(url).toBe(`${SITE_ORIGIN}/?p=${p}&d=easy`);
  });
});

const LEGACY_ORIGIN = `https://${LEGACY_HOST}`;

/**
 * 旧 URL と新しい URL への通信を、テストのサーバー（baseURL）に振り向ける。ページからは https の 2 つの URL に見える。
 * 本文は圧縮せずに受け取る（受け取った本文は展開済みなので、圧縮の印が残るとブラウザが展開し直して壊れる）。
 * 振り向けた通信（メソッドと URL）と、テストの終わり（afterEach）に呼ぶ end を返す
 */
async function routeHosts(context: BrowserContext, baseURL: string) {
  const routed: string[] = [];
  let ended = false;
  // 振り向け漏れが本番に届かないよう、テストのサーバー以外への https の通信はすべて止める
  // （後から登録した route が優先されるので、下の振り向けはそのまま動く）
  const local = new URL(baseURL).origin;
  await context.route(
    (url) => url.protocol === "https:" && url.origin !== local,
    (route) => route.abort(),
  );
  for (const origin of [LEGACY_ORIGIN, SITE_ORIGIN]) {
    await context.route(`${origin}/**`, async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      routed.push(`${req.method()} ${url.origin}${url.pathname}`);
      try {
        const response = await context.request.fetch(baseURL + url.pathname + url.search, {
          method: req.method(),
          data: req.postDataBuffer() ?? undefined,
          headers: { "content-type": req.headers()["content-type"] ?? "", "accept-encoding": "identity" },
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      } catch (e) {
        // 後片付けの context.close() は、ページを閉じる前に context.request を破棄し、受け取った本文も消す。
        // テストが待たずに終えた通信（最後に開いたページの履歴の取得など）が振り向けの途中だと、
        // fetch や fulfill が失敗する（Fetch response has been disposed）。テストの後なので失敗にしない。
        // unrouteAll({ behavior: "ignoreErrors" }) と同じだが、route は外さない（外すと残りの通信が本番に届く）
        if (!ended) throw e;
      }
    });
  }
  return {
    routed,
    end: () => {
      ended = true;
    },
  };
}

/** 旧 URL の端末にだけ保存データを入れる（新しい URL の端末は空のまま） */
async function seedLegacy(page: Page, items: Record<string, unknown>) {
  await page.addInitScript(
    ({ host, items }) => {
      if (location.hostname !== host) return;
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v));
    },
    { host: LEGACY_HOST, items },
  );
}

/** origin の localStorage（開いていない origin の分も読む） */
async function storageOf(context: BrowserContext, origin: string): Promise<Record<string, string>> {
  const { origins } = await context.storageState();
  const found = origins.find((o) => o.origin === origin);
  return Object.fromEntries((found?.localStorage ?? []).map((e) => [e.name, e.value]));
}

/** シートの動きが止まってから撮る */
async function sheetShot(dialog: Locator, name: string) {
  if (!SHOTS) return;
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await shot(dialog.page(), name);
}

test.describe("URL の移行", () => {
  test.skip(!!process.env.E2E_BASE_URL, "旧・新の URL をテストのサーバーに振り向けるので、ローカルだけ");
  // 本物の Service Worker が登録されると、振り向けた応答を差し替えられないことがある
  test.use({ serviceWorkers: "block" });

  /** 振り向けた通信（routeHosts） */
  let routed: string[] = [];
  let endRouting = () => {};
  test.beforeEach(async ({ context, baseURL }) => {
    ({ routed, end: endRouting } = await routeHosts(context, baseURL!));
  });
  // afterEach は後片付け（context.close）より前に必ず走る
  test.afterEach(() => endRouting());
  const claimRequests = () => routed.filter((r) => r === `POST ${SITE_ORIGIN}/api/player/claim`);

  const MOVE_PLAYER = { id: "77777777-7777-4777-8777-777777777777", name: "旧URL" };
  const MOVE_STATS = {
    easy: {
      played: 2,
      bestMs: 95_000,
      cleanBestMs: null,
      bestPoints: 1200,
      started: 3,
      trackedClears: 2,
      totalMs: 200_000,
      abandonedMs: 30_000,
    },
  };
  const moveSheet = (page: Page) => page.getByRole("dialog", { name: "新しい URL へ移る" });
  const claimSheet = (page: Page) => page.getByRole("dialog", { name: "引き継ぎ" });
  const moveBar = (page: Page) => page.getByRole("note").filter({ hasText: "URL が変わりました" });
  const installHint = (page: Page) => page.getByText("「ホーム画面に追加」でアプリになります");
  const homeHeading = (page: Page) => page.getByRole("heading", { name: "ナンプレ" });
  /**
   * origin のページを開いたときの履歴の取得（/api/player/history）と、新しい URL ではログインの状態の確認
   * （/api/auth/me。旧 URL では確かめない）の応答。開く前に作り、ページを離れる前に待つ
   * （WebKit は、取得の途中でページを離れると、切れた fetch をページのエラーとして報告する）
   */
  const historyLoaded = (page: Page, origin = SITE_ORIGIN) =>
    Promise.all([
      page.waitForResponse((r) => r.url().startsWith(`${origin}/api/player/history`)),
      origin === SITE_ORIGIN ? authChecked(page, origin) : null,
    ]);

  /** テストのサーバーで MOVE_PLAYER の引き継ぎコードを発行する */
  async function issueCode(request: APIRequestContext) {
    const res = await request.post("/api/player/transfer", {
      data: { playerId: MOVE_PLAYER.id, name: MOVE_PLAYER.name, stats: MOVE_STATS },
    });
    expect(res.status()).toBe(200);
    return ((await res.json()) as { code: string }).code;
  }

  test("旧 URL で記録のある端末は、開くたびに移る案内を出し、記録を移して新しい URL で引き継げる。旧 URL の記録は残る", async ({
    page,
    context,
  }, info) => {
    await seedLegacy(page, { "sudoku:player": MOVE_PLAYER, "sudoku:stats": MOVE_STATS });
    const loaded = historyLoaded(page, LEGACY_ORIGIN);
    await page.goto(`${LEGACY_ORIGIN}/`);
    const move = moveSheet(page);
    await expect(move).toBeVisible();
    await expect(move.getByText("nanpure-game.vercel.app")).toBeVisible();
    await sheetShot(move, "move-sheet");

    // 閉じるとホームに閉じられない案内を出し、ホーム画面への追加は案内しない。開き直すとまた出す
    await move.getByRole("button", { name: "閉じる" }).click();
    await expect(move).toBeHidden();
    await expect(moveBar(page)).toBeVisible();
    await expect(moveBar(page).getByRole("button", { name: "閉じる" })).toHaveCount(0);
    await expect(installHint(page)).toHaveCount(0);
    await shot(page, "move-bar");
    await moveBar(page).getByRole("button", { name: "移る" }).click();
    await expect(move).toBeVisible();
    await move.getByRole("button", { name: "閉じる" }).click();
    await loaded;
    await page.reload();
    await expect(move).toBeVisible();
    await expect(page).toHaveURL(`${LEGACY_ORIGIN}/`);

    await move.getByRole("button", { name: "記録を移して開く" }).click();
    const claim = claimSheet(page);
    await expect(claim).toBeVisible();
    // コードは URL に残さない
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await expect(claim.locator(".code")).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(claim.getByText("この端末のプレイヤーは置き換わります")).toHaveCount(0);
    await sheetShot(claim, "claim-sheet");
    await claim.getByRole("button", { name: "引き継ぐ" }).click();
    await expect(claim.getByText("引き継ぎました")).toBeVisible();
    await expect(claim.getByText("毎日の通知")).toHaveCount(0);
    await claim.getByRole("button", { name: "閉じる" }).click();
    await expect(claim).toBeHidden();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    // 新しい URL では、旧 URL の案内を出さない（iPhone の Safari ならホーム画面への追加を案内する）
    await expect(moveBar(page)).toHaveCount(0);
    if (isIphone(info)) await expect(installHint(page)).toBeVisible();
    await page.getByRole("button", { name: "設定" }).click();
    await expect(page.getByRole("dialog", { name: "設定" }).getByText("旧URL")).toBeVisible();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);

    const moved = await storageOf(context, SITE_ORIGIN);
    expect(JSON.parse(moved["sudoku:player"])).toEqual(MOVE_PLAYER);
    expect(JSON.parse(moved["sudoku:stats"])).toEqual(MOVE_STATS);
    const legacy = await storageOf(context, LEGACY_ORIGIN);
    expect(JSON.parse(legacy["sudoku:player"])).toEqual(MOVE_PLAYER);
    expect(JSON.parse(legacy["sudoku:stats"])).toEqual(MOVE_STATS);
    // 発行と受け取りはテストのサーバーに届いている
    expect(routed).toContain(`POST ${LEGACY_ORIGIN}/api/player/transfer`);
    expect(claimRequests()).toHaveLength(1);
  });

  test("旧 URL で記録の無い端末は、同じパスとクエリで新しい URL へ移り、旧 URL には何も保存しない", async ({
    page,
    context,
  }) => {
    await page.goto(`${LEGACY_ORIGIN}/?from=e2e`);
    await expect(page).toHaveURL(`${SITE_ORIGIN}/?from=e2e`);
    await expect(homeHeading(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(moveBar(page)).toHaveCount(0);
    expect(await storageOf(context, LEGACY_ORIGIN)).toEqual({});
    expect(await storageOf(context, SITE_ORIGIN)).toHaveProperty("sudoku:player");
  });

  test("旧 URL で記録の無い端末は、共有した盤面の URL でも新しい URL へ移り、その盤面を始める", async ({
    page,
    context,
  }) => {
    await page.goto(`${LEGACY_ORIGIN}/?p=${SHARED_PUZZLE}&d=extreme`);
    await sharedSheet(page).getByRole("button", { name: "始める", exact: true }).click();
    await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
    await expect(page.locator(".bar-main")).toHaveText("極");
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    expect(await storageOf(context, LEGACY_ORIGIN)).toEqual({});
    expect(JSON.parse((await storageOf(context, SITE_ORIGIN))["sudoku:free"]).puzzle).toEqual(
      gridOf(SHARED_PUZZLE),
    );
  });

  test("iPhone のホーム画面に追加したアプリでは、新しい URL を開かずにコードと手順を出す", async ({
    page,
    request,
  }, info) => {
    test.skip(!isIphone(info), "iPhone だけ");
    await seedLegacy(page, { "sudoku:player": MOVE_PLAYER, "sudoku:stats": MOVE_STATS });
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { configurable: true, value: true }),
    );
    await page.goto(`${LEGACY_ORIGIN}/`);
    const move = moveSheet(page);
    await expect(move.getByRole("button", { name: "記録を移して開く" })).toHaveCount(0);
    await move.getByRole("button", { name: "コードを発行" }).click();
    const code = move.locator(".transfer-code .code");
    await expect(code).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await expect(move.getByRole("button", { name: "コピー" })).toBeVisible();
    await expect(move.getByText("24時間有効・1回だけ使えます")).toBeVisible();
    await expect(move.getByRole("listitem")).toHaveText([
      "Safari で nanpure-game.vercel.app を開く",
      "共有メニューの「ホーム画面に追加」",
      "追加したアプリの設定で「コードを入力」",
    ]);
    await expect(move.getByText("通知は新しい URL で設定し直してください")).toHaveCount(0);
    await sheetShot(move, "move-sheet-standalone");
    await expect(page).toHaveURL(`${LEGACY_ORIGIN}/`);
    // 出したコードは新しい URL の設定で入力して使える
    const res = await request.post("/api/player/claim", { data: { code: await code.textContent() } });
    expect(await res.json()).toMatchObject({ playerId: MOVE_PLAYER.id, name: MOVE_PLAYER.name });
  });

  test("移る途中でページを保存したまま戻ってきたら（ブラウザの戻る）、また押せる", async ({ page }) => {
    await seedLegacy(page, { "sudoku:player": MOVE_PLAYER });
    // 発行の応答を止めておき、押した後の状態のままにする
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/player/transfer", async (route) => {
      await held;
      await route.abort();
    });
    await page.goto(`${LEGACY_ORIGIN}/`);
    const move = moveSheet(page);
    const button = move.getByRole("button", { name: "記録を移して開く" });
    await button.click();
    await expect(move.locator(".spinner")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(button).toBeEnabled();
    release();
    await expect(move.getByText("オフラインです")).toBeVisible();
  });

  test("旧 URL から開いた新しい URL で記録のある端末は、置き換わることを示す。やめるとコードを使わない", async ({
    page,
    context,
    request,
  }) => {
    const here = { id: "88888888-8888-4888-8888-888888888888", name: "この端末" };
    await page.addInitScript((p) => localStorage.setItem("sudoku:player", p), JSON.stringify(here));
    const code = await issueCode(request);
    await page.goto(`${SITE_ORIGIN}/#code=${code.toLowerCase()}`, { referer: `${LEGACY_ORIGIN}/` });
    const claim = claimSheet(page);
    await expect(claim.locator(".code")).toHaveText(`${code.slice(0, 4)}-${code.slice(4)}`);
    await expect(claim.getByText("この端末のプレイヤーは置き換わります")).toBeVisible();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await sheetShot(claim, "claim-sheet-replace");
    await claim.getByRole("button", { name: "やめる" }).click();
    await expect(claim).toBeHidden();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await page.getByRole("button", { name: "設定" }).click();
    await expect(
      page.getByRole("dialog", { name: "設定" }).getByText("この端末", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    expect(claimRequests()).toEqual([]);
    expect(JSON.parse((await storageOf(context, SITE_ORIGIN))["sudoku:player"])).toEqual(here);
    // コードはまだ使える
    const res = await request.post("/api/player/claim", { data: { code } });
    expect(res.status()).toBe(200);
  });

  test("旧 URL から開いた使用済みのコードでは、引き継げないことを示し、プレイヤーは変わらない", async ({
    page,
    context,
    request,
  }) => {
    const code = await issueCode(request);
    expect((await request.post("/api/player/claim", { data: { code } })).status()).toBe(200);
    await page.goto(`${SITE_ORIGIN}/#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    const claim = claimSheet(page);
    await claim.getByRole("button", { name: "引き継ぐ" }).click();
    await expect(claim.getByText("コードが見つかりません")).toBeVisible();
    await expect(claim.getByText("引き継ぎました")).toHaveCount(0);
    await sheetShot(claim, "claim-sheet-used");
    const player = JSON.parse((await storageOf(context, SITE_ORIGIN))["sudoku:player"]);
    expect(player.id).not.toBe(MOVE_PLAYER.id);
  });

  test("旧 URL 以外から開いた #code のリンクでは、シートを出さずに URL から消し、コードを使わない", async ({
    page,
    context,
    request,
  }) => {
    const here = { id: "99999999-9999-4999-8999-999999999999", name: "この端末" };
    await page.addInitScript((p) => localStorage.setItem("sudoku:player", p), JSON.stringify(here));
    const code = await issueCode(request);
    for (const [i, referer] of [undefined, "https://example.com/", `${SITE_ORIGIN}/`].entries()) {
      // fragment だけが違う URL ではページを読み直さないので、クエリを変えて開く
      const loaded = historyLoaded(page);
      await page.goto(`${SITE_ORIGIN}/?n=${i}#code=${code}&push=1`, { referer });
      await expect(homeHeading(page)).toBeVisible();
      await expect(page, String(referer)).toHaveURL(`${SITE_ORIGIN}/?n=${i}`);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await loaded;
    }
    expect(claimRequests()).toEqual([]);
    expect(JSON.parse((await storageOf(context, SITE_ORIGIN))["sudoku:player"])).toEqual(here);
    expect((await request.post("/api/player/claim", { data: { code } })).status()).toBe(200);
  });

  test("旧 URL から開いた後に fragment だけを別のコードに替え、再読み込みや戻るで開き直しても、シートを出さずに URL から消す", async ({
    page,
    request,
  }) => {
    const code = await issueCode(request);
    const other = await issueCode(request);
    // 旧 URL から新しく開いたときはシートを出す
    let loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    const claim = claimSheet(page);
    await expect(claim).toBeVisible();
    await claim.getByRole("button", { name: "やめる" }).click();
    await expect(claim).toBeHidden();
    await loaded;

    // 同じページのまま fragment だけを替えて（ページは作り直されない）再読み込みする。referrer は旧 URL のまま
    await page.evaluate((c) => (location.hash = `code=${c}`), other);
    loaded = historyLoaded(page);
    await page.reload();
    await expect(homeHeading(page)).toBeVisible();
    expect(await page.evaluate(() => document.referrer)).toBe(`${LEGACY_ORIGIN}/`);
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await loaded;

    // 戻る・進むで開き直したときも出さない
    await page.evaluate((c) => (location.hash = `code=${c}`), other);
    loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/?n=1`);
    await loaded;
    await page.goBack();
    await expect(homeHeading(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    expect(claimRequests()).toEqual([]);
    expect((await request.post("/api/player/claim", { data: { code: other } })).status()).toBe(200);
  });

  test("形の違うコードのリンクはシートを出さずに URL から消す。旧 URL で受けたコードは使わずに消す", async ({
    page,
    request,
  }) => {
    const loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/#code=xyz`, { referer: `${LEGACY_ORIGIN}/` });
    await expect(homeHeading(page)).toBeVisible();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await loaded;

    await seedLegacy(page, { "sudoku:player": MOVE_PLAYER });
    const code = await issueCode(request);
    await page.goto(`${LEGACY_ORIGIN}/#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    await expect(moveSheet(page)).toBeVisible();
    await expect(claimSheet(page)).toHaveCount(0);
    await expect(page).toHaveURL(`${LEGACY_ORIGIN}/`);
    // コードはまだ使える
    expect((await request.post("/api/player/claim", { data: { code } })).status()).toBe(200);
  });

  test("旧 URL で通知をオンにしていた端末は、移るときに旧 URL の購読を外し、引き継いだあとに通知の項目を出す", async ({
    page,
    context,
  }, info) => {
    // iPhone では通知の偽物がホーム画面に追加したアプリとして開くので、新しい URL を開かない
    test.skip(isIphone(info), "デスクトップだけ");
    await fakePush(page, { permission: "granted", subscribed: true, reminder: true, host: LEGACY_HOST });
    const sent = await routePush(page);
    await page.goto(`${LEGACY_ORIGIN}/`);
    const deleted = page.waitForResponse(isPushApi("DELETE"));
    await moveSheet(page).getByRole("button", { name: "記録を移して開く" }).click();
    await deleted;
    expect(sent.filter((s) => s.method === "DELETE")).toEqual([
      { method: "DELETE", body: { playerId: PUSH_PLAYER, endpoint: fakeEndpoint(0) } },
    ]);

    const claim = claimSheet(page);
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await expect(claim.getByText("この端末のプレイヤーは置き換わります")).toHaveCount(0);
    await claim.getByRole("button", { name: "引き継ぐ" }).click();
    await expect(claim.getByText("引き継ぎました")).toBeVisible();
    await expect(claim.getByRole("checkbox", { name: /毎日の通知/ })).toBeVisible();
    await sheetShot(claim, "claim-sheet-push");
    const legacy = await storageOf(context, LEGACY_ORIGIN);
    expect(legacy).not.toHaveProperty("sudoku:reminder");
    expect(legacy["sudoku:moved-with-reminder"]).toBe("true");
  });

  test("通知をオンにしていた端末が、移った先から旧 URL に戻ってもう一度移っても、引き継いだあとに通知の項目を出す", async ({
    page,
  }, info) => {
    test.skip(isIphone(info), "デスクトップだけ");
    // 通知をオンにした印は最初に開いたときだけ入れる（戻って読み込み直したときは入れ直さない）
    await fakePush(page, {
      permission: "granted",
      subscribed: true,
      reminder: true,
      host: LEGACY_HOST,
      once: true,
    });
    const sent = await routePush(page);
    await page.goto(`${LEGACY_ORIGIN}/`);
    const deleted = page.waitForResponse(isPushApi("DELETE"));
    const loaded = historyLoaded(page);
    await moveSheet(page).getByRole("button", { name: "記録を移して開く" }).click();
    await deleted;
    await expect(claimSheet(page)).toBeVisible();
    await loaded;

    // 受け取らずに旧 URL へ戻る。旧 URL の通知の印は 1 回目で外れている
    await page.goBack();
    await expect(page).toHaveURL(`${LEGACY_ORIGIN}/`);
    const move = moveSheet(page);
    await expect(move).toBeVisible();
    expect(await reminderFlag(page)).toBeNull();
    await move.getByRole("button", { name: "記録を移して開く" }).click();

    const claim = claimSheet(page);
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await claim.getByRole("button", { name: "引き継ぐ" }).click();
    await expect(claim.getByText("引き継ぎました")).toBeVisible();
    await expect(claim.getByRole("checkbox", { name: /毎日の通知/ })).toBeVisible();
    // 購読を外したのは 1 回目だけ
    expect(sent.filter((s) => s.method === "DELETE")).toHaveLength(1);
  });

  test("ログイン中の端末では、旧 URL から開いた #code のリンクでもシートを出さずに URL から消し、コードを使わない", async ({
    page,
    request,
  }) => {
    const here = { id: randomUUID(), name: "ログイン中" };
    await page.addInitScript((p) => localStorage.setItem("sudoku:player", p), JSON.stringify(here));
    // ログイン中と答える（このテストではアカウントを作らない。同じプレイヤーで記録も無いので、ほかの通信はしない）
    await page.route(`${SITE_ORIGIN}/api/auth/me`, (route) =>
      route.fulfill({ json: { account: { playerId: here.id, name: here.name, passkeys: 1, stats: null } } }),
    );
    const code = await issueCode(request);
    const loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    await expect(homeHeading(page)).toBeVisible();
    await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    await loaded;
    await nextFrames(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "設定" }).click();
    const settings = page.getByRole("dialog", { name: "設定" });
    await expect(settings.getByRole("button", { name: /^アカウント/ })).toContainText("ログイン中");
    await expect(settings.getByRole("button", { name: "コードを入力" })).toHaveCount(0);
    expect(claimRequests()).toEqual([]);
    expect((await request.post("/api/player/claim", { data: { code } })).status()).toBe(200);
  });

  test("ログインの状態を確かめている間にゲームや設定を開いたら、旧 URL からの受け取るシートはホームに戻って閉じてから開く", async ({
    page,
    request,
  }) => {
    const code = await issueCode(request);
    const holdMe = async () => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`${SITE_ORIGIN}/api/auth/me`, async (route) => {
        await held;
        await route.fallback();
      });
      return release;
    };
    const claim = claimSheet(page);

    // 設定を開いている間に分かったら、設定を閉じてから開く
    let release = await holdMe();
    let loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/?n=1#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    await page.getByRole("button", { name: "設定" }).click();
    const settings = page.getByRole("dialog", { name: "設定" });
    await expect(settings).toBeVisible();
    release();
    await loaded;
    await nextFrames(page);
    await expect(claim).toHaveCount(0);
    await settings.getByRole("button", { name: "閉じる" }).click();
    await expect(claim).toBeVisible();
    await claim.getByRole("button", { name: "やめる" }).click();
    await expect(claim).toBeHidden();
    await page.unrouteAll({ behavior: "wait" });

    // ゲームを開いている間に分かったら、ホームに戻ってから開く
    release = await holdMe();
    loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/?n=2#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    await expect(homeHeading(page)).toBeVisible();
    await page.locator(".free-easy").click();
    await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
    release();
    await loaded;
    await nextFrames(page);
    await expect(claim).toHaveCount(0);
    await page.getByRole("button", { name: "ホームに戻る" }).click();
    await expect(claim).toBeVisible();
    await claim.getByRole("button", { name: "やめる" }).click();
    expect(claimRequests()).toEqual([]);
  });

  test("今日の一問を始める途中にログインの状態が分かっても、受け取るシートはゲームの上に出さず、ホームに戻ってから開く", async ({
    page,
    request,
  }) => {
    const here = { id: randomUUID(), name: "この端末" };
    await page.addInitScript((p) => localStorage.setItem("sudoku:player", p), JSON.stringify(here));
    const code = await issueCode(request);
    /** release を呼ぶまで応答を止める */
    const holdRoute = async (path: string) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route(`${SITE_ORIGIN}${path}`, async (route) => {
        await held;
        await route.fallback();
      });
      return release;
    };
    const releaseMe = await holdRoute("/api/auth/me");
    const releaseStart = await holdRoute("/api/daily/start");
    const loaded = historyLoaded(page);
    await page.goto(`${SITE_ORIGIN}/#code=${code}`, { referer: `${LEGACY_ORIGIN}/` });
    await expect(homeHeading(page)).toBeVisible();
    const started = page.waitForRequest(`${SITE_ORIGIN}/api/daily/start`);
    await page.locator(".daily-row").first().click();
    await started;

    // 始める途中（開始の応答を待っている間）に、ログインしていないと分かっても開かない
    releaseMe();
    await loaded;
    await nextFrames(page);
    const claim = claimSheet(page);
    await expect(claim).toHaveCount(0);
    // ゲームが始まっても、ゲームの上には出さず、プレイヤーも替わらない
    releaseStart();
    await expect(page.getByLabel("ランキング戦")).toBeVisible();
    await nextFrames(page);
    await expect(claim).toHaveCount(0);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem("sudoku:player")))!)).toEqual(here);

    // ホームに戻ったら開く
    await page.getByRole("button", { name: "ホームに戻る" }).click();
    await expect(claim).toBeVisible();
    await claim.getByRole("button", { name: "やめる" }).click();
    await expect(claim).toBeHidden();
    expect(claimRequests()).toEqual([]);
  });

  test("ローカルやプレビューの URL では、記録があっても移る案内を出さない", async ({
    page,
    baseURL,
  }, info) => {
    await page.addInitScript((p) => localStorage.setItem("sudoku:player", p), JSON.stringify(MOVE_PLAYER));
    await page.goto("/");
    await expect(homeHeading(page)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(moveBar(page)).toHaveCount(0);
    if (isIphone(info)) await expect(installHint(page)).toBeVisible();
    await expect(page).toHaveURL(`${baseURL}/`);
  });
});

/** 仮想の認証器（パスキーを保存する端末の代わり）。Chromium の CDP でだけ使える */
type Authenticator = { cdp: CDPSession; id: string };

/** 認証器を足す。パスキーを端末に保存し、本人確認とタップは自動で通す */
async function newAuthenticator(cdp: CDPSession): Promise<Authenticator> {
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: authenticatorId };
}

async function addAuthenticator(page: Page): Promise<Authenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  return newAuthenticator(cdp);
}

const passkeysOf = async (a: Authenticator) =>
  (await a.cdp.send("WebAuthn.getCredentials", { authenticatorId: a.id })).credentials;

/** from の認証器のパスキーを to の認証器に写す（同じパスキーを同期した別の端末の代わり） */
async function copyPasskeys(from: Authenticator, to: Authenticator) {
  const credentials = await passkeysOf(from);
  expect(credentials.length).toBeGreaterThan(0);
  for (const credential of credentials) {
    await to.cdp.send("WebAuthn.addCredential", { authenticatorId: to.id, credential });
  }
}

test.describe("アカウント（パスキー）", () => {
  test.skip(!!process.env.E2E_BASE_URL, "アカウントを作るので、ローカルのサーバーだけ（本番を汚さない）");

  const EASY = {
    played: 2,
    bestMs: 95_000,
    cleanBestMs: null,
    bestPoints: 1200,
    started: 3,
    trackedClears: 2,
    totalMs: 200_000,
  };
  const MEDIUM = {
    played: 1,
    bestMs: 300_000,
    cleanBestMs: 300_000,
    bestPoints: 2000,
    started: 1,
    trackedClears: 1,
    totalMs: 300_000,
  };
  const CDP_ONLY = "仮想の認証器（CDP）は Chromium だけ";

  /**
   * テストごとに回数制限の枠を分ける（アカウントの作成は IP ごとに 1 時間 5 件、options の取得は 60 回。
   * サーバーは実行の間ずっと同じなので、iPhone とデスクトップでも分ける）。呼ぶたびに次の IP
   */
  let ipCount = 0;
  const ipHeaders = (info: TestInfo) => ({
    "x-forwarded-for": `${isIphone(info) ? "198.51.100" : "203.0.113"}.${++ipCount}`,
  });

  /** タブで初めて開いたときだけ保存データを入れる（読み込み直しても入れ直さない） */
  async function seed(page: Page, items: Record<string, unknown>) {
    await page.addInitScript((items) => {
      if (sessionStorage.getItem("e2e:seeded")) return;
      sessionStorage.setItem("e2e:seeded", "1");
      for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v));
    }, items);
  }

  const stored = (page: Page, key: string) =>
    page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
  const settingsSheet = (page: Page) => page.getByRole("dialog", { name: "設定" });
  const accountSheet = (page: Page) => page.getByRole("dialog", { name: "アカウント" });
  const accountRow = (page: Page) => settingsSheet(page).locator(".settings-link", { hasText: "アカウント" });

  /** パスキーの操作の options の取得（開いたときと操作の後に先取りする）の応答 */
  const optionsLoaded = (page: Page, kinds: ("signup" | "login" | "passkeys")[]) =>
    Promise.all(
      kinds.map((k) => page.waitForResponse((r) => new URL(r.url()).pathname === `/api/auth/${k}/options`)),
    );

  /**
   * 設定からアカウントを開き、options を取り終えるまで待つ（取り終える前に押すと、もう一度押すよう示す）。
   * 既定はログインしていない端末（ログインと作成の options）
   */
  async function openAccount(page: Page, kinds: ("signup" | "login" | "passkeys")[] = ["login", "signup"]) {
    await page.getByRole("button", { name: "設定" }).click();
    const loaded = optionsLoaded(page, kinds);
    await accountRow(page).click();
    await loaded;
    return accountSheet(page);
  }

  /** アカウントを作る（ログインしていない端末で、アカウントを開いた状態から） */
  async function createAccount(sheet: Locator) {
    await sheet.getByRole("button", { name: "アカウントを作成" }).click();
    await expect(sheet.getByText("作成しました")).toBeVisible();
  }

  test("アカウントを作り、別の端末でパスキーでログインすると、同じプレイヤー・名前になり記録が合わさる。ログイン中はコードを入力できない", async ({
    browser,
  }, info) => {
    test.skip(isIphone(info), CDP_ONLY);
    const headers = ipHeaders(info);
    const owner = { id: randomUUID(), name: "作成元" };
    const a = await browser.newContext({ extraHTTPHeaders: headers });
    // ランキングの名前（アカウントの名前）をサーバーに保存しておく
    expect(
      (await a.request.post("/api/player", { data: { playerId: owner.id, name: owner.name } })).ok(),
    ).toBe(true);
    const pa = await a.newPage();
    const authA = await addAuthenticator(pa);
    await seed(pa, { "sudoku:player": owner, "sudoku:stats": { easy: EASY } });
    await pa.goto("/");
    await pa.getByRole("button", { name: "設定" }).click();
    await expect(accountRow(pa)).toContainText("ログインしていません");
    await settingsSheet(pa).getByRole("button", { name: "閉じる" }).click();

    let sheet = await openAccount(pa);
    await sheetShot(sheet, "account-signed-out");
    await createAccount(sheet);
    await expect(sheet.getByText("1 件")).toBeVisible();
    await expect(sheet.getByRole("button", { name: "追加" })).toBeVisible();
    await sheetShot(sheet, "account-signed-in");
    expect(await stored(pa, "sudoku:player")).toEqual(owner);
    // ログイン中は、設定の引き継ぎでコードを入力できない（発行はできる）
    await sheet.getByRole("button", { name: "閉じる" }).click();
    await pa.getByRole("button", { name: "設定" }).click();
    await expect(accountRow(pa)).toContainText("ログイン中");
    await expect(settingsSheet(pa).getByRole("button", { name: "コードを発行" })).toBeVisible();
    await expect(settingsSheet(pa).getByRole("button", { name: "コードを入力" })).toHaveCount(0);
    await accountRow(pa).scrollIntoViewIfNeeded();
    await sheetShot(settingsSheet(pa), "settings-account");

    // 同期したパスキーを持つ別の端末（別のプレイヤーで遊んでいた）でログインする
    const b = await browser.newContext({ extraHTTPHeaders: headers });
    const pb = await b.newPage();
    await copyPasskeys(authA, await addAuthenticator(pb));
    const other = { id: randomUUID(), name: "別の端末" };
    await seed(pb, { "sudoku:player": other, "sudoku:stats": { medium: MEDIUM } });
    const merges: unknown[] = [];
    pb.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/auth/merge") merges.push(r.postDataJSON());
    });
    await pb.goto("/");
    sheet = await openAccount(pb);
    await sheet.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(sheet.getByText("ログインしました")).toBeVisible();
    await expect(sheet.getByText("1 件")).toBeVisible();
    // 別の端末で使っていたプレイヤーの今日の一問の履歴を写し、アカウントのプレイヤーになる
    expect(merges).toEqual([{ fromPlayerId: other.id }]);
    expect(await stored(pb, "sudoku:player")).toEqual(owner);
    expect(await stored(pb, "sudoku:stats")).toEqual({ easy: EASY, medium: MEDIUM });
    const me = await pb.evaluate(() => fetch("/api/auth/me").then((r) => r.json()));
    expect(me.account).toEqual({
      playerId: owner.id,
      name: owner.name,
      passkeys: 1,
      stats: { easy: EASY, medium: MEDIUM },
    });

    // 開き直してもログイン中のまま（同じプレイヤーなので、履歴は写し直さない）
    const checked = authChecked(pb);
    await pb.reload();
    await checked;
    await pb.getByRole("button", { name: "設定" }).click();
    await expect(accountRow(pb)).toContainText("ログイン中");
    await expect(settingsSheet(pb).getByText(owner.name)).toBeVisible();
    expect(merges).toHaveLength(1);
    await a.close();
    await b.close();
  });

  test("ログアウトすると、まだ送っていない記録を送ってから、この端末の記録を消して新しいプレイヤーになる。通知の印は残り、購読は新しいプレイヤーに移す。アカウントの記録は残る", async ({
    page,
  }, info) => {
    test.skip(isIphone(info), CDP_ONLY);
    await page.context().setExtraHTTPHeaders(ipHeaders(info));
    await addAuthenticator(page);
    await fakePush(page, { permission: "granted", subscribed: true, reminder: true, once: true });
    const sent = await routePush(page);
    const owner = { id: randomUUID(), name: null };
    const result = {
      date: "2026-10-01",
      difficulty: "easy",
      timeMs: 100_000,
      points: 1000,
      rank: 1,
      total: 1,
    };
    await seed(page, {
      "sudoku:player": owner,
      "sudoku:stats": { easy: EASY },
      "sudoku:result:2026-10-01:easy": result,
      "sudoku:daily:2026-10-01:easy": { version: 1 },
    });
    const registered = page.waitForResponse(isPushApi("POST"));
    await page.goto("/");
    await registered;
    const sheet = await openAccount(page);
    await createAccount(sheet);
    // ホームに戻らずに（同期せずに）増えた記録
    await page.evaluate((s) => localStorage.setItem("sudoku:stats", JSON.stringify(s)), {
      easy: EASY,
      medium: MEDIUM,
    });
    const order: string[] = [];
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (path === "/api/auth/stats" || path === "/api/auth/logout") order.push(`${r.method()} ${path}`);
    });

    await sheet.getByRole("button", { name: "ログアウト", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "ログアウトしますか？" });
    await expect(confirm.getByText("この端末の記録は消えます。アカウントの記録は残ります。")).toBeVisible();
    await sheetShot(confirm, "account-logout");
    const ready = optionsLoaded(page, ["login", "signup"]);
    const moved = page.waitForResponse(isPushApi("POST"));
    await confirm.getByRole("button", { name: "ログアウト" }).click();
    await ready;
    await expect(sheet.getByRole("button", { name: "アカウントを作成" })).toBeVisible();
    await moved;
    const fresh = await stored(page, "sudoku:player");
    expect(fresh.id).not.toBe(owner.id);
    expect(fresh.name).toBeNull();
    expect(await stored(page, "sudoku:stats")).toBeNull();
    expect(await stored(page, "sudoku:result:2026-10-01:easy")).toBeNull();
    expect(await stored(page, "sudoku:daily:2026-10-01:easy")).toBeNull();
    expect(await reminderFlag(page)).toBe("true");
    expect(sent.map((s) => (s.body as { playerId: string }).playerId)).toEqual([owner.id, fresh.id]);
    expect(order).toEqual(["PUT /api/auth/stats", "POST /api/auth/logout"]);

    // もう一度ログインすると、アカウントのプレイヤーと記録（ログアウトの前に送った分を含む）に戻る
    await sheet.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(sheet.getByText("ログインしました")).toBeVisible();
    expect((await stored(page, "sudoku:player")).id).toBe(owner.id);
    expect(await stored(page, "sudoku:stats")).toEqual({ easy: EASY, medium: MEDIUM });
  });

  test("パスキーを追加できる。登録済みのパスキーがある認証器には作らない。足したパスキーでもログインできる", async ({
    browser,
  }, info) => {
    test.skip(isIphone(info), CDP_ONLY);
    const headers = ipHeaders(info);
    const context = await browser.newContext({ extraHTTPHeaders: headers });
    const page = await context.newPage();
    const first = await addAuthenticator(page);
    await seed(page, { "sudoku:player": { id: randomUUID(), name: null } });
    await page.goto("/");
    const sheet = await openAccount(page);
    const ready = optionsLoaded(page, ["passkeys"]);
    await createAccount(sheet);
    await ready;

    await sheet.getByRole("button", { name: "追加" }).click();
    await expect(sheet.getByText("このパスキーは登録済みです")).toBeVisible();
    await expect(sheet.getByText("1 件")).toBeVisible();

    // 別の認証器なら足せる（さっきの options をそのまま使う）
    await first.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: first.id });
    const second = await newAuthenticator(first.cdp);
    await sheet.getByRole("button", { name: "追加" }).click();
    await expect(sheet.getByText("追加しました")).toBeVisible();
    await expect(sheet.getByText("2 件")).toBeVisible();
    await expect(sheet.getByText("このパスキーは登録済みです")).toHaveCount(0);

    const other = await browser.newContext({ extraHTTPHeaders: headers });
    const po = await other.newPage();
    await copyPasskeys(second, await addAuthenticator(po));
    await po.goto("/");
    const otherSheet = await openAccount(po);
    await otherSheet.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(otherSheet.getByText("ログインしました")).toBeVisible();
    await expect(otherSheet.getByText("2 件")).toBeVisible();
    await context.close();
    await other.close();
  });

  test("アカウントを削除すると、そのパスキーではログインできない。端末のプレイヤーと記録は残る", async ({
    page,
  }, info) => {
    test.skip(isIphone(info), CDP_ONLY);
    await page.context().setExtraHTTPHeaders(ipHeaders(info));
    await addAuthenticator(page);
    const owner = { id: randomUUID(), name: null };
    await seed(page, { "sudoku:player": owner, "sudoku:stats": { easy: EASY } });
    await page.goto("/");
    const sheet = await openAccount(page);
    await createAccount(sheet);

    await sheet.getByRole("button", { name: "アカウントを削除" }).click();
    const confirm = page.getByRole("dialog", { name: "アカウントを削除しますか？" });
    await expect(
      confirm.getByText("パスキーではログインできなくなります。この端末の記録は残ります。"),
    ).toBeVisible();
    await sheetShot(confirm, "account-delete");
    // 削除の応答を止めておき、処理中は閉じられないことを確かめる
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/auth/account", async (route) => {
      await held;
      await route.continue();
    });
    const ready = optionsLoaded(page, ["login", "signup"]);
    await confirm.getByRole("button", { name: "削除する" }).click();
    await expect(confirm.locator(".spinner")).toBeVisible();
    await expectNotClosable(confirm);
    release();
    await ready;
    await expect(sheet.getByRole("button", { name: "アカウントを作成" })).toBeVisible();
    expect(await stored(page, "sudoku:player")).toEqual(owner);
    expect(await stored(page, "sudoku:stats")).toEqual({ easy: EASY });

    await sheet.getByRole("button", { name: "ログイン", exact: true }).click();
    await expect(sheet.getByText("ログインできませんでした")).toBeVisible();
    expect(await stored(page, "sudoku:player")).toEqual(owner);
    await sheet.getByRole("button", { name: "閉じる" }).click();
    await page.getByRole("button", { name: "設定" }).click();
    await expect(accountRow(page)).toContainText("ログインしていません");
  });

  test("アカウントに紐づいたプレイヤーの端末では作成せず、ログインを促す", async ({ browser }, info) => {
    test.skip(isIphone(info), CDP_ONLY);
    const headers = ipHeaders(info);
    const owner = { id: randomUUID(), name: null };
    const a = await browser.newContext({ extraHTTPHeaders: headers });
    const pa = await a.newPage();
    await addAuthenticator(pa);
    await seed(pa, { "sudoku:player": owner });
    await pa.goto("/");
    await createAccount(await openAccount(pa));
    await a.close();

    // 同じプレイヤー（引き継ぎコードなどで移した）の、ログインしていない端末
    const b = await browser.newContext({ extraHTTPHeaders: headers });
    const pb = await b.newPage();
    const authB = await addAuthenticator(pb);
    await seed(pb, { "sudoku:player": owner });
    await pb.goto("/");
    const sheet = await openAccount(pb);
    await sheet.getByRole("button", { name: "アカウントを作成" }).click();
    await expect(sheet.getByText("このプレイヤーのアカウントがあります。ログインしてください")).toBeVisible();
    await sheetShot(sheet, "account-linked");
    // パスキーの画面を出さない（パスキーを作らない）
    expect(await passkeysOf(authB)).toEqual([]);
    await b.close();
  });

  test("サーバーにアカウントの設定が無ければ（503）、設定にアカウントの項目を出さない", async ({ page }) => {
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({ status: 503, json: { error: "auth unavailable" } }),
    );
    const me = authChecked(page);
    await page.goto("/");
    await me;
    await page.getByRole("button", { name: "設定" }).click();
    const settings = settingsSheet(page);
    await expect(settings.getByRole("button", { name: "コードを入力" })).toBeVisible();
    await nextFrames(page);
    await expect(settings.getByText("アカウント")).toHaveCount(0);
  });

  test("パスキーを使えない端末では、使えないことを示し、開けない", async ({ page }) => {
    await page.addInitScript(() =>
      Object.defineProperty(window, "PublicKeyCredential", {
        configurable: true,
        writable: true,
        value: undefined,
      }),
    );
    const me = authChecked(page);
    await page.goto("/");
    expect((await me).status()).toBe(200);
    await page.getByRole("button", { name: "設定" }).click();
    await expect(accountRow(page)).toContainText("この端末では使えません");
    await expect(settingsSheet(page).getByRole("button", { name: /アカウント/ })).toHaveCount(0);
  });

  test("パスキーの画面を閉じた（NotAllowedError）ときは何も示さず、もう一度押せる。続けて押しても画面は 1 回だけ出す", async ({
    page,
  }, info) => {
    await page.context().setExtraHTTPHeaders(ipHeaders(info));
    // パスキーの画面を閉じたときと同じ失敗を返す（__hold の間は __release まで返さない）。
    // WebKit のテスト用ブラウザでも、パスキーを使える端末として扱う
    await page.addInitScript(() => {
      const w = window as unknown as { __gets: number; __hold: boolean; __release: () => void };
      w.__gets = 0;
      w.__hold = false;
      let held: (() => void)[] = [];
      w.__release = () => {
        for (const reject of held) reject();
        held = [];
      };
      if (typeof window.PublicKeyCredential !== "function") {
        Object.defineProperty(window, "PublicKeyCredential", {
          configurable: true,
          writable: true,
          value: function PublicKeyCredential() {},
        });
      }
      const fail = () => {
        w.__gets++;
        const err = new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
        if (!w.__hold) return Promise.reject(err);
        return new Promise((_, reject) => held.push(() => reject(err)));
      };
      Object.defineProperty(navigator, "credentials", {
        configurable: true,
        value: { get: fail, create: fail },
      });
    });
    await page.goto("/");
    const sheet = await openAccount(page);
    const gets = () => page.evaluate(() => (window as unknown as { __gets: number }).__gets);
    const login = sheet.getByRole("button", { name: "ログイン", exact: true });
    await login.click();
    await expect.poll(gets).toBe(1);
    await expect(login).toBeEnabled();
    await nextFrames(page);
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    await expect(sheet.getByRole("status")).toHaveCount(0);
    // 同じ options のまま、もう一度パスキーの画面を出せる
    await login.click();
    await expect.poll(gets).toBe(2);
    await expect(login).toBeEnabled();
    await expect(sheet.getByRole("alert")).toHaveCount(0);

    // パスキーの画面を出している間は押せないので、続けて押しても（ダブルクリック）1 回だけ
    await page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
    await login.dblclick();
    await expect.poll(gets).toBe(3);
    await nextFrames(page);
    expect(await gets()).toBe(3);
    // 処理中は閉じられない
    await expectNotClosable(sheet);
    await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
    await expect(login).toBeEnabled();
    await expect(sheet.getByRole("alert")).toHaveCount(0);
    // 終われば閉じられる
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  test("アカウントの項目はホームの設定にだけ出す（ゲームの途中の設定には出さない）", async ({ page }) => {
    const me = authChecked(page);
    await page.goto("/");
    await me;
    await page.getByRole("button", { name: "設定" }).click();
    await expect(accountRow(page)).toBeVisible();
    await settingsSheet(page).getByRole("button", { name: "閉じる" }).click();

    await page.locator(".free-easy").click();
    await expect(page.getByRole("grid", { name: "ナンプレの盤面" })).toBeVisible();
    await page.getByRole("button", { name: "設定" }).click();
    await expect(settingsSheet(page).getByRole("button", { name: "遊び方" })).toBeVisible();
    await expect(settingsSheet(page).getByText("アカウント")).toHaveCount(0);
  });

  test("ログインの状態を確かめている間は、引き継ぎのコードを入力させない", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/auth/me", async (route) => {
      await held;
      await route.continue();
    });
    await page.goto("/");
    await page.getByRole("button", { name: "設定" }).click();
    const settings = settingsSheet(page);
    await expect(settings.getByRole("button", { name: "コードを発行" })).toBeVisible();
    await nextFrames(page);
    await expect(settings.getByRole("button", { name: "コードを入力" })).toHaveCount(0);
    const me = authChecked(page);
    release();
    await me;
    await expect(settings.getByRole("button", { name: "コードを入力" })).toBeVisible();
  });
});
