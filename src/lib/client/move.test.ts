import { describe, expect, it } from "vitest";
import { LEGACY_HOST, SITE_ORIGIN } from "@/lib/site";
import { normalizeCode } from "@/lib/transfer-code";
import { installMemoryStorage } from "./memoryStorage";
import {
  fromLegacy,
  hasLocalData,
  isLegacyHost,
  legacyTarget,
  markMovedWithReminder,
  movedWithReminder,
  moveUrl,
  navigationAllowsClaim,
  parseMoveHash,
} from "./move";
import { reminderOn, setReminderOn } from "./push";
import { KEYS } from "./storage";

const { store } = installMemoryStorage();

const PLAYER = "11111111-1111-4111-8111-111111111111";

describe("旧 URL の判定", () => {
  it("前の本番のホスト名だけを旧 URL とみなす", () => {
    expect(isLegacyHost(LEGACY_HOST)).toBe(true);
    for (const host of [
      new URL(SITE_ORIGIN).hostname,
      "localhost",
      "127.0.0.1",
      "sudoku-git-main-makoto041s-projects.vercel.app",
      "sudoku-makoto041s-projects.vercel.app",
      `${LEGACY_HOST}.example.com`,
      `x${LEGACY_HOST}`,
      "",
    ]) {
      expect(isLegacyHost(host), host).toBe(false);
    }
  });

  it("記録の無い端末は、同じパスとクエリで新しい URL へ移す", () => {
    expect(legacyTarget("/", "")).toBe(`${SITE_ORIGIN}/`);
    expect(legacyTarget("/", "?a=1")).toBe(`${SITE_ORIGIN}/?a=1`);
  });
});

describe("記録があるか", () => {
  /** 開いただけで保存するもの（名前の無いプレイヤー・実績・空の履歴）と、記録でない設定 */
  const opened = () => {
    store.set(KEYS.player, JSON.stringify({ id: PLAYER, name: null }));
    store.set(KEYS.achievements, JSON.stringify({ "daily-first": null }));
    store.set(KEYS.historyCache, "[]");
    store.set(KEYS.settings, JSON.stringify({ sound: false }));
    store.set(KEYS.clockOffset, "120");
    store.set(KEYS.installHint, "true");
    store.set(KEYS.howto, "true");
  };

  it("何も無い・開いただけの端末は記録なし", () => {
    expect(hasLocalData()).toBe(false);
    opened();
    expect(hasLocalData()).toBe(false);
  });

  it("名前・記録・途中の盤面・練習・今日の一問・履歴・通知のどれか 1 つでもあれば記録あり", () => {
    const cases: [string, string][] = [
      [KEYS.player, JSON.stringify({ id: PLAYER, name: "名前" })],
      [KEYS.stats, JSON.stringify({ easy: { played: 1, bestMs: 1000, cleanBestMs: null } })],
      [KEYS.free, JSON.stringify({ version: 1 })],
      [KEYS.practice, JSON.stringify({ "naked-single": ["a"] })],
      [KEYS.dailyResult("2026-10-01", "easy"), JSON.stringify({ date: "2026-10-01", difficulty: "easy" })],
      [KEYS.daily("2026-10-01", "hard"), JSON.stringify({ version: 1 })],
      [KEYS.historyCache, JSON.stringify([{ date: "2026-10-01", difficulty: "easy" }])],
      [KEYS.reminder, "true"],
      [KEYS.movedWithReminder, "true"],
    ];
    for (const [key, value] of cases) {
      store.clear();
      opened();
      store.set(key, value);
      expect(hasLocalData(), key).toBe(true);
    }
  });

  it("空の名前・空の記録・空の練習・true 以外の通知の印は記録なし", () => {
    const cases: [string, string][] = [
      [KEYS.player, JSON.stringify({ id: PLAYER, name: "" })],
      [KEYS.player, JSON.stringify({ id: PLAYER, name: 1 })],
      [KEYS.stats, "{}"],
      [KEYS.stats, JSON.stringify({ junk: { played: 9 } })],
      [KEYS.practice, "{}"],
      [KEYS.practice, JSON.stringify({ "naked-single": [] })],
      [KEYS.reminder, "false"],
      [KEYS.reminder, '"true"'],
      [KEYS.movedWithReminder, "false"],
      [KEYS.movedWithReminder, '"true"'],
    ];
    for (const [key, value] of cases) {
      store.clear();
      opened();
      store.set(key, value);
      expect(hasLocalData(), `${key} ${value}`).toBe(false);
    }
  });

  it("壊れた保存データは記録なし", () => {
    for (const key of [
      KEYS.player,
      KEYS.stats,
      KEYS.free,
      KEYS.practice,
      KEYS.dailyResult("2026-10-01", "easy"),
      KEYS.daily("2026-10-01", "easy"),
      KEYS.historyCache,
      KEYS.reminder,
      KEYS.movedWithReminder,
    ]) {
      store.clear();
      store.set(key, "{");
      expect(hasLocalData(), key).toBe(false);
    }
  });
});

describe("通知をオンにしたまま移った印", () => {
  it("覚えると読め、この印だけを書く。保存した true のときだけ印あり", () => {
    expect(movedWithReminder()).toBe(false);
    markMovedWithReminder();
    expect(movedWithReminder()).toBe(true);
    expect([...store.keys()]).toEqual([KEYS.movedWithReminder]);
    for (const raw of ["{", "false", '"true"', "1", "null"]) {
      store.set(KEYS.movedWithReminder, raw);
      expect(movedWithReminder(), raw).toBe(false);
    }
  });

  it("旧 URL で通知をオンにし直すと消える。オフにしても消えない", () => {
    markMovedWithReminder();
    setReminderOn(false);
    expect(movedWithReminder()).toBe(true);
    setReminderOn(true);
    expect(movedWithReminder()).toBe(false);
    expect(reminderOn()).toBe(true);
  });
});

describe("新しい URL で受け取るリンク", () => {
  it("コードを整えて読み、通知の印を読む", () => {
    expect(parseMoveHash("#code=abcd-efgh&push=1")).toEqual({ code: "ABCDEFGH", push: true });
    expect(parseMoveHash("#code=ABCDEFGH")).toEqual({ code: "ABCDEFGH", push: false });
    expect(parseMoveHash("code=ABCDEFGH&push=0")).toEqual({ code: "ABCDEFGH", push: false });
  });

  it("コードの形が違えば code を null にする（code= があるので URL から消す対象）", () => {
    for (const hash of [
      "#code=",
      "#code=xyz",
      "#code=ABCDEFG",
      "#code=ABCDEFGHJ",
      "#code=ABCDEFGI",
      "#code=ABCDEFGO",
      "#code=ABCDEFG0",
      "#code=ABCDEFG1",
    ]) {
      expect(parseMoveHash(hash), hash).toEqual({ code: null, push: false });
    }
    expect(parseMoveHash("#code=xyz&push=1")).toEqual({ code: null, push: true });
  });

  it("code= が無ければ null", () => {
    for (const hash of ["", "#", "#foo", "#push=1", "#codes=ABCDEFGH"]) {
      expect(parseMoveHash(hash), hash).toBeNull();
    }
  });

  it("リンクはコードを fragment に入れる。読み直すと同じ中身になる", () => {
    expect(moveUrl("ABCDEFGH", false)).toBe(`${SITE_ORIGIN}/#code=ABCDEFGH`);
    expect(moveUrl("ABCDEFGH", true)).toBe(`${SITE_ORIGIN}/#code=ABCDEFGH&push=1`);
    for (const push of [false, true]) {
      const url = new URL(moveUrl("ABCDEFGH", push));
      expect(url.search).toBe("");
      expect(parseMoveHash(url.hash)).toEqual({ code: "ABCDEFGH", push });
    }
  });

  it("URL に入れたコードを、入力欄と同じ規則で整える", () => {
    for (const raw of ["abcd-efgh", "ABCD EFGH", "ABCDEFGI", "xyz"]) {
      expect(parseMoveHash(`#code=${encodeURIComponent(raw)}`)?.code, raw).toBe(normalizeCode(raw));
    }
  });

  it("旧 URL のページから開かれたときだけ、受け取るシートを開く", () => {
    for (const referrer of [
      `https://${LEGACY_HOST}/`,
      `https://${LEGACY_HOST}/?a=1#b`,
      `https://${LEGACY_HOST}`,
    ]) {
      expect(fromLegacy(referrer), referrer).toBe(true);
    }
    for (const referrer of [
      "",
      "not a url",
      "/",
      `${SITE_ORIGIN}/`,
      `http://${LEGACY_HOST}/`,
      `https://${LEGACY_HOST}:8443/`,
      `https://${LEGACY_HOST}.example.com/`,
      `https://x.${LEGACY_HOST}/`,
      "https://example.com/",
      "http://localhost:3100/",
    ]) {
      expect(fromLegacy(referrer), referrer).toBe(false);
    }
  });

  it("新しく開いた読み込みだけ、受け取るシートを開く（再読み込み・戻る/進む・取れないときは開かない）", () => {
    expect(navigationAllowsClaim("navigate")).toBe(true);
    for (const type of ["reload", "back_forward", "prerender", "", undefined]) {
      expect(navigationAllowsClaim(type), String(type)).toBe(false);
    }
  });
});
