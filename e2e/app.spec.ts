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

type Saved = { puzzle: number[]; solution: number[] | null; values: number[] };

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
  await page.getByPlaceholder("ニックネーム").fill(`テスト${test.info().project.name}`);
  await shot(page, "name-sheet");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByText("ランキング戦")).toBeVisible();

  const key = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("sudoku:daily:"))!,
  );
  const g = await savedGame(page, key);
  expect(g.solution).toBeNull();
  const solution = solve(g.puzzle)!;
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
