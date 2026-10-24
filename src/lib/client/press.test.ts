import { describe, expect, it } from "vitest";
import { CLICK_AFTER_UP_MS, PressGuard } from "./press";

describe("押した時点で動かすボタンの click", () => {
  it("click だけが届いたら動かす（読み上げソフトのダブルタップ・Enter・Space）", () => {
    const g = new PressGuard();
    expect(g.click(3, 0)).toBe(true);
    expect(g.click(3, 10)).toBe(true);
  });

  it("pointerdown で動かした操作に続く click は無視し、その次の click は動かす", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.up(1, 100);
    expect(g.click(3, 110)).toBe(false);
    expect(g.click(3, 120)).toBe(true);
  });

  it("長押ししてから離しても、続く click は無視する", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.up(1, 5000);
    expect(g.click(3, 5010)).toBe(false);
  });

  it("離す前に届いた click も無視する", () => {
    const g = new PressGuard();
    g.down(3, 1);
    expect(g.click(3, 10)).toBe(false);
  });

  it("別のボタンへの click は動かす。押したボタンの分は、離してからしばらくで忘れる", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.up(1, 100);
    // 押したボタンの外で離すと、click は押したボタンには届かない
    expect(g.click(-1, 110)).toBe(true);
    expect(g.click(5, 120)).toBe(true);
    expect(g.click(3, 100 + CLICK_AFTER_UP_MS + 1)).toBe(true);
  });

  it("取り消された押し方の後の click は動かす", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.cancel(1);
    expect(g.click(3, 10)).toBe(true);
  });

  it("2 本の指で続けて押しても、それぞれの click を取り違えない", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.down(5, 2);
    g.up(1, 100);
    expect(g.click(3, 110)).toBe(false);
    g.up(2, 150);
    expect(g.click(5, 160)).toBe(false);
    expect(g.click(3, 170)).toBe(true);
    expect(g.click(5, 180)).toBe(true);
  });

  it("2 本の指で同じボタンを押したら、click も 2 回分無視する", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.down(3, 2);
    g.up(1, 100);
    expect(g.click(3, 110)).toBe(false);
    g.up(2, 150);
    expect(g.click(3, 160)).toBe(false);
    expect(g.click(3, 170)).toBe(true);
  });

  it("同じポインタで押し直したときは、離した時刻を前の押し方に付け直さない", () => {
    const g = new PressGuard();
    g.down(3, 1);
    g.up(1, 100);
    g.down(4, 1);
    g.up(1, 100 + CLICK_AFTER_UP_MS);
    // 3 の分は離してから時間が経っているので忘れ、4 の分は残っている
    expect(g.click(3, 100 + CLICK_AFTER_UP_MS + 10)).toBe(true);
    expect(g.click(4, 100 + CLICK_AFTER_UP_MS + 20)).toBe(false);
  });
});
