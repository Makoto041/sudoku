import { expect, test, type Locator, type Page } from "@playwright/test";
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

test("色を付けたマスでも、間違い・手筋ヒント・複数選択の基準のマスが分かるよう、色の上に印を描く", async ({
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

  // 手筋ヒントで注目する範囲のマスは、色を付けても点線の枠で分かる。色を変えてもヒントは閉じない
  await page.keyboard.press("h");
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

  // 間違えた数字のマスは、色で赤い背景が隠れても、角の三角と濃く太い数字で分かる
  const [a, b] = g.puzzle.flatMap((v, i) => (v || i === focus || i === target ? [] : [i]));
  await page.keyboard.press("c");
  for (const i of [a, b]) {
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

  // 複数選択では、基準のマスの枠を他の選択マスより太くする。基準のマスに色が無くても同じ
  // （色の無い基準のマスは、行き詰まりにならない最初から入っているマスで確かめる）
  const plain = g.puzzle.findIndex((v, i) => v !== 0 && i !== focus);
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
