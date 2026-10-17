import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

type Listener = (event: Record<string, unknown>) => void;

/** public/sw.js を偽の self で動かし、登録したイベントの処理と、表示した通知・開いたウィンドウを返す */
function loadServiceWorker(windows: { focus: () => Promise<unknown> }[] = []) {
  const listeners = new Map<string, Listener>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const matchAll = vi.fn(async () => windows);
  const self = {
    addEventListener: (type: string, fn: Listener) => listeners.set(type, fn),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      matchAll,
      openWindow: async (url: string) => {
        opened.push(url);
        return null;
      },
    },
  };
  runInNewContext(SOURCE, { self });
  /** イベントを送り、waitUntil に渡した処理が 1 つだけで、終わるまで待つ */
  const fire = async (type: string, init: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    listeners.get(type)!({ ...init, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
  };
  return { listeners, shown, opened, matchAll, fire };
}

/** PushEvent の data（PushMessageData）の代わり。読んだかを確かめられるようにする */
const payload = (text: string) => ({ json: vi.fn(() => JSON.parse(text)) });

describe("Service Worker の通知", () => {
  it("push と notificationclick を受け、pushsubscriptionchange は受けない", () => {
    const { listeners } = loadServiceWorker();
    expect(listeners.has("push")).toBe(true);
    expect(listeners.has("notificationclick")).toBe(true);
    expect(listeners.has("pushsubscriptionchange")).toBe(false);
  });

  // 鍵が漏れて任意の中身を送られても、決まった文言しか出さない
  it.each([
    ["別の文言", payload(JSON.stringify({ title: "当選しました", body: "https://evil.example/", url: "x" }))],
    ["JSON でない", payload("not json")],
    ["中身なし", null],
  ])("届いた中身によらず（%s）、固定の文言・印・アイコンの通知を出し、中身を読まない", async (_, data) => {
    const sw = loadServiceWorker();
    await sw.fire("push", { data });
    expect(sw.shown).toEqual([
      {
        title: "ナンプレ",
        options: {
          body: "今日の一問はまだです",
          tag: "daily-reminder",
          renotify: true,
          icon: "/icon-192.png",
        },
      },
    ]);
    if (data) expect(data.json).not.toHaveBeenCalled();
  });

  it("通知を押すと閉じ、ウィンドウが無ければトップを開く（中身に URL があっても使わない）", async () => {
    const sw = loadServiceWorker();
    const close = vi.fn();
    await sw.fire("notificationclick", {
      notification: { close, data: { url: "https://evil.example/" } },
      action: "https://evil.example/",
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(sw.matchAll).toHaveBeenCalledWith({ type: "window", includeUncontrolled: true });
    expect(sw.opened).toEqual(["/"]);
  });

  it("開いているウィンドウがあれば前に出し、新しくは開かない", async () => {
    const focus = vi.fn(async () => null);
    const sw = loadServiceWorker([{ focus }, { focus: vi.fn(async () => null) }]);
    await sw.fire("notificationclick", { notification: { close: vi.fn() } });
    expect(focus).toHaveBeenCalledTimes(1);
    expect(sw.opened).toEqual([]);
  });
});
