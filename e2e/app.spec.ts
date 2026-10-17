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

type Saved = {
  puzzle: number[];
  solution: number[] | null;
  values: number[];
  history: unknown[];
  moves?: unknown[];
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

test("フリープレイを最後まで解ける", async ({ page }) => {
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
  await expect(page.locator(".rec-table tbody tr").first().locator("td").first()).toHaveText("1");
  await shot(page, "records");
});

test("引き継ぎコードで別の端末に同じプレイヤーを移せる", async ({ browser }) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await pa.addInitScript(() =>
    localStorage.setItem(
      "sudoku:player",
      JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", name: "引き継ぎ元" }),
    ),
  );
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
  await b.close();
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
