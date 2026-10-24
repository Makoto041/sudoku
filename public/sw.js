// オフラインでもフリープレイを遊べるようにするための Service Worker
// 版を上げると、この Service Worker が入れ替わり、保存済みの応答（ヘッダーごと保存する）を取り直す。
// v3: セキュリティヘッダー（CSP など）を付けた。前の版で保存したトップには CSP が付いていない
const CACHE = "sudoku-v3";
const PRECACHE = [
  "/",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/apple-touch-icon.png",
  "/sounds/clack.mp3",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // ランキングは常に最新を取りに行く
  if (url.pathname.startsWith("/api/")) return;

  // ハッシュ付きの静的ファイルは変わらないのでキャッシュ優先
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // ページはネットワーク優先、つながらなければ保存済みのトップを返す
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
    return;
  }

  // アイコンなどは手元を先に返し、裏で更新する
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});

// 毎日の通知。文言はここで固定し、届いた中身は読まない（VAPID の秘密鍵と購読の鍵が漏れても、任意の文言を出させない）。
// サーバーが送る中身（src/lib/server/push.ts の REMINDER）と同じ文言にしておく
self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("ナンプレ", {
      body: "今日の一問はまだです",
      // 同じ印の通知は並べずに置き換える。置き換えたときも知らせる
      tag: "daily-reminder",
      renotify: true,
      icon: "/icon-192.png",
    }),
  );
});

// 通知を押したら、開いているウィンドウを前に出し、無ければトップを開く。開く先は中身によらず固定
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => "focus" in w);
      return open ? open.focus() : self.clients.openWindow("/");
    }),
  );
});
