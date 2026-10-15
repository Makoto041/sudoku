import { expect, test, type Page } from "@playwright/test";
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

type Saved = { puzzle: number[]; solution: number[] | null; values: number[]; history: unknown[] };

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

test("フリープレイを最後まで解ける", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "数独" })).toBeVisible();
  await shot(page, "home");

  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "数独の盤面" })).toBeVisible();
  const g = await savedGame(page, "sudoku:free");
  const cells = page.getByRole("gridcell");
  const first = g.puzzle.indexOf(0);
  await cells.nth(first).dispatchEvent("pointerdown", { pointerType: "touch", button: 0 });
  // メモを付けてから、間違い → 正解の順に入れる
  await page.getByRole("button", { name: "メモ" }).click();
  for (const d of [1, 2, 5]) await page.keyboard.press(`Digit${d}`);
  await page.getByRole("button", { name: "メモ" }).click();
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
  await page.waitForTimeout(700);
  await shot(page, "result-free");
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
  await expect(page.getByText("ランキング戦")).toBeVisible();

  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
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
  await expect(page.getByRole("grid", { name: "数独の盤面" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".bar-main")).toHaveText("鬼");
  const g = await savedGame(page, "sudoku:free");
  expect(g.puzzle.filter((v) => v !== 0).length).toBeLessThanOrEqual(28);
});

test("シートの背景をタップしても、下のボタンが押されない", async ({ page }, info) => {
  test.skip(!info.project.use.hasTouch, "タッチ端末だけで起きる");
  await page.addInitScript(() =>
    localStorage.setItem("sudoku:player", JSON.stringify({ id: crypto.randomUUID(), name: "背景" })),
  );
  await page.goto("/");
  let started = false;
  page.on("request", (r) => {
    if (r.url().includes("/api/daily/start")) started = true;
  });
  const row = (await page.locator(".daily-row").first().boundingBox())!;
  await page.getByRole("button", { name: "設定" }).click();
  await expect(page.getByRole("dialog", { name: "設定" })).toBeVisible();
  await page.touchscreen.tap(row.x + row.width / 2, row.y + row.height / 2);
  await expect(page.getByRole("dialog", { name: "設定" })).toBeHidden();
  await page.waitForTimeout(500);
  expect(started).toBe(false);
  await expect(page.getByRole("heading", { name: "数独" })).toBeVisible();
});

test("間違えたマスに正しい数字を入れ直すと揺れない", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "数独の盤面" })).toBeVisible();
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
  await expect(page.getByText("ランキング戦")).toBeVisible();
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
  await expect(page.getByText("ランキング戦")).toBeVisible();
  const after = await savedGame(page, key);
  expect(after.values[g.puzzle.indexOf(0)]).toBe(5);
});

test("行き詰まったら知らせ、間違える前まで戻せる", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: /かんたん/ })
    .last()
    .click();
  await expect(page.getByRole("grid", { name: "数独の盤面" })).toBeVisible();
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
  await expect(page.getByText("ランキング戦")).toBeVisible();
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
  await expect(page.locator(".stat-value").first()).toHaveText("1");
});

test("置く音の録音を配信している", async ({ request }) => {
  const res = await request.get("/sounds/clack.mp3");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("audio/mpeg");
  expect((await res.body()).length).toBeGreaterThan(1000);
});
