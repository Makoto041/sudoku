import { ApiError, api } from "./api";
import { iosNeedsInstall } from "./device";
import { KEYS, load, remove, save } from "./storage";

/**
 * 毎日の通知の状態
 * - unavailable：サーバーに通知の設定が無い・公開鍵を取れない（設定に項目を出さない）
 * - needs-install：iOS の Safari のページ（ホーム画面に追加したアプリでだけ使える）
 * - unsupported：この端末・ブラウザでは使えない
 * - denied：通知の許可がブロックされている
 * - off・on
 */
export type PushState = "unavailable" | "needs-install" | "unsupported" | "denied" | "off" | "on";

export type PushSupport = "supported" | "unsupported" | "needs-install";

/** 操作の失敗の種類（画面の文言に写す）。エラーの中身（endpoint・鍵）は持たない */
export type PushError = "rate-limited" | "offline" | "failed";

export type PushResult = { state: PushState; error?: PushError };

/** 通知を有効にしたか。保存した true のときだけ有効（無い・壊れている・読めないときは無効） */
export const reminderOn = () => load<unknown>(KEYS.reminder) === true;

export function setReminderOn(on: boolean) {
  if (on) save(KEYS.reminder, true);
  else remove(KEYS.reminder);
}

/**
 * base64url（= を付けない形）をバイト列にする。使えない文字・=・半端な長さ・
 * 余りのビットが 0 でない（同じ文字列に戻らない）ものは null
 */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  const back = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return back === value ? Uint8Array.from(binary, (c) => c.charCodeAt(0)) : null;
}

/** VAPID の公開鍵（P-256 の点を未圧縮で表した 65 バイト。0x04 で始まる）。形が違えば null */
export function publicKeyBytes(value: unknown): Uint8Array<ArrayBuffer> | null {
  if (typeof value !== "string") return null;
  const bytes = base64UrlToBytes(value);
  return bytes && bytes.length === 65 && bytes[0] === 0x04 ? bytes : null;
}

/** 取れた公開鍵。開いている間は覚えておく（取れなかったときは次に取り直す） */
let knownKey: Uint8Array<ArrayBuffer> | null = null;

/** 公開鍵をサーバーから取る。503（通知の設定が無い）・通信の失敗・形の違う鍵は null */
async function publicKey(): Promise<Uint8Array<ArrayBuffer> | null> {
  if (knownKey) return knownKey;
  try {
    knownKey = publicKeyBytes((await api.pushKey()).publicKey);
  } catch {
    knownKey = null;
  }
  return knownKey;
}

/** この端末で通知を使えるか。iOS はホーム画面に追加したアプリでだけ使える（iOS 16.4 以降） */
export function pushSupport(): PushSupport {
  if (iosNeedsInstall()) return "needs-install";
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    ? "supported"
    : "unsupported";
}

type Operation = "enable" | "disable" | "refresh";

/**
 * 次の操作が 1 つの操作を待つ最大の時間（期限）。過ぎたら、その操作の完了を待たずに次の操作に進む
 * （通信が止まった操作があっても、後の操作と設定の表示が詰まらないように）。期限を過ぎた操作は止めずに続ける
 */
const QUEUE_TIMEOUT_MS = 15_000;

/**
 * serial が操作に渡すもの
 * - turn：購読と印に触れる前に呼んで待つ。前の操作が終わるか、その期限が来ると解決する
 * - passed：期限を過ぎて、後の操作に追い越されたか（後の操作が turn を通ったか）。turn を通った後に使う
 */
type Slot = { turn: () => Promise<void>; passed: () => boolean };

/**
 * 最後に始めた操作（有効にする・無効にする・登録し直す）。操作は 1 つずつ順に行う
 * （シートを閉じて開き直して押したときや、開いたときの登録し直しの途中で無効にしたときに、購読を残さないため）。
 * done は前の操作の done の後、この操作が終わるか期限が来たら、これが最後の操作なら外したあとに解決する（失敗しない）。
 * result は done の後、操作が終わったときにその結果になる
 */
let last: { operation: Operation; playerId: string; result: Promise<unknown>; done: Promise<void> } | null =
  null;

/** turn を通った操作の数（追い越されたかを見るのに使う） */
let begun = 0;

/**
 * 操作を前の操作の後に行う。最後の操作が同じ操作・同じプレイヤーなら、新しく始めずにその結果を返す（続けて押しても 1 回だけ）。
 * run はすぐに呼ぶ。run は購読と印に触れる前に turn() を待つ
 * （許可を求めるのはユーザーの操作の中で最初の await より前でないとできないので、待つ前に求められるようにする）。
 * 期限は、順番が来てから数える。turn() を呼ぶのが順番より遅ければ（有効にする操作は許可の答えが出てから呼ぶ）、
 * 呼んだときから数え直すので、許可のダイアログに答えるまでの時間は期限に数えない。ただし答えが出ないまま期限が来たら、
 * 次の操作は待たずに進む（ダイアログを放っておかれても詰まらないように）。その後に許可されれば、その操作は続ける
 */
function serial<T>(operation: Operation, playerId: string, run: (slot: Slot) => Promise<T>): Promise<T> {
  if (last && last.operation === operation && last.playerId === playerId) return last.result as Promise<T>;
  const prev = last ? last.done : Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let released = false;
  let release!: () => void;
  const done: Promise<void> = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      clearTimeout(timer);
      resolve();
    };
  }).then(() => {
    if (last?.done === done) last = null;
  });
  /** 期限を（数え直して）決める。操作が終わった・期限が来た後は何もしない */
  const arm = () => {
    if (released) return;
    clearTimeout(timer);
    timer = setTimeout(release, QUEUE_TIMEOUT_MS);
  };
  let mine = 0;
  let turn: Promise<void> | undefined;
  const slot: Slot = {
    turn: () =>
      (turn ??= prev.then(() => {
        mine = ++begun;
        arm();
      })),
    passed: () => begun !== mine,
  };
  void prev.then(arm);
  const running = run(slot);
  void prev.then(() => running).then(release, release);
  const result = done.then(() => running);
  last = { operation, playerId, result, done };
  return result;
}

/** 実行中・待っている操作がすべて終わるまで待つ（1 つの操作を待つのは期限まで） */
async function idle() {
  while (last) await last.done;
}

const READY_TIMEOUT_MS = 10_000;

/** Service Worker の登録。まだ有効になっていなければ少し待つ。登録が無い・待っても有効にならなければ null */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  if (reg.active) return reg;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS)),
  ]);
}

/**
 * 設定シートに出す状態。実行中の操作があれば、終わってから読む（シートを閉じて開き直したときは、終わるまで項目を出さない）。
 * ただし 1 つの操作を待つのは期限（QUEUE_TIMEOUT_MS）までで、過ぎたらその時点の状態を読む。
 * 次の順に決め、読めないものがあっても例外にしない
 * 1. サーバーから公開鍵を取れなければ unavailable
 * 2. iOS の Safari のページなら needs-install、通知の API が無ければ unsupported
 * 3. 許可がブロックされていれば denied
 * 4. 許可されていて、有効にした印があり、購読が残っていれば on。ほかは off（購読を読めないときも off）
 */
export async function loadPushState(): Promise<PushState> {
  await idle();
  try {
    if (!(await publicKey())) return "unavailable";
    const support = pushSupport();
    if (support !== "supported") return support;
    const permission = Notification.permission;
    if (permission === "denied") return "denied";
    if (permission !== "granted" || !reminderOn()) return "off";
    const sub = await registration()
      .then((reg) => reg?.pushManager.getSubscription())
      .catch(() => null);
    return sub ? "on" : "off";
  } catch {
    return "unavailable";
  }
}

/** ブラウザの購読を外す。外せなくても続ける（残った購読は、サーバーが送れなかったときに消す） */
async function dropSubscription(reg: ServiceWorkerRegistration | null) {
  try {
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  } catch {
    /* noop */
  }
}

/** サーバーから消し、ブラウザの購読を外す。サーバーから消せなくても外す（外した購読にはプッシュサービスが 404・410 を返し、サーバーが消す） */
async function withdraw(playerId: string, sub: PushSubscription) {
  await api.unsubscribePush(playerId, sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  return new Uint8Array(a).every((x, i) => x === b[i]);
}

/** 購読を作る。別の公開鍵で作った購読が残っていると作れないので、外してから作る */
async function subscribe(reg: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>) {
  const old = await reg.pushManager.getSubscription();
  if (old && !sameBytes(old.options?.applicationServerKey, key)) await old.unsubscribe();
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/**
 * 購読をサーバーに登録する。409（同じ endpoint を、別のプレイヤーが auth の違う鍵で登録済み）なら、
 * 購読を作り直して 1 回だけ登録し直す。作り直した購読も登録できなければ、理由によらず 409 として失敗にする
 * （呼び出し側で購読と印を外す）。
 * 作り直す直前と登録し直した直後に wanted でまだ有効にしたいかを確かめ、無効にされていれば（別のタブで無効にしたなど）、
 * 作らずに、または作った購読をサーバーから消して外して終える
 */
async function register(
  playerId: string,
  reg: ServiceWorkerRegistration,
  sub: PushSubscription,
  wanted: () => boolean,
) {
  try {
    await api.subscribePush(playerId, sub.toJSON());
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 409)) throw err;
    const key = await publicKey();
    if (!key) throw new ApiError(503, "push unavailable");
    await sub.unsubscribe();
    if (!wanted()) return;
    let fresh: PushSubscription;
    try {
      fresh = await subscribe(reg, key);
      await api.subscribePush(playerId, fresh.toJSON());
    } catch {
      throw err;
    }
    if (!wanted()) await withdraw(playerId, fresh);
  }
}

/** 失敗を画面の文言の種類に写す。429 は回数の上限、0 は通信の失敗、ほか（400・409・503・購読の失敗など）は failed */
function failureOf(err: unknown): PushError {
  if (err instanceof ApiError && err.status === 429) return "rate-limited";
  if (err instanceof ApiError && err.status === 0) return "offline";
  return "failed";
}

/**
 * 通知を有効にする。設定のトグルを押したときに呼ぶ。許可を求めるのはユーザーの操作の中でないとできないので、
 * 最初の await より前に求める（前の操作を待つのはその後。公開鍵は状態を読んだときに取ってあるので、ここでは通信しない）。
 * 許可 → 購読 → サーバーに登録 → 印を付ける。途中で失敗したら購読を外し、印を付けない。
 * ただし期限を過ぎて後の操作に追い越されていたら、失敗しても購読と印に触れない（今の購読と印は後の操作のもの）
 */
export function enablePush(playerId: string): Promise<PushResult> {
  return serial("enable", playerId, async ({ turn, passed }): Promise<PushResult> => {
    let permission: NotificationPermission;
    try {
      permission = await Notification.requestPermission();
    } catch {
      return { state: "off", error: "failed" };
    }
    if (permission === "denied") return { state: "denied" };
    if (permission !== "granted") return { state: "off" };
    // 答えが出てから順番を待つ（答えるまでの時間を期限に数えない）
    await turn();
    let reg: ServiceWorkerRegistration | null = null;
    try {
      const key = await publicKey();
      reg = await registration();
      if (!key || !reg) throw new Error("push unavailable");
      await register(playerId, reg, await subscribe(reg, key), () => true);
      setReminderOn(true);
      return { state: "on" };
    } catch (err) {
      if (!passed()) {
        await dropSubscription(reg);
        setReminderOn(false);
      }
      return { state: "off", error: failureOf(err) };
    }
  });
}

/** 通知を無効にする。サーバーから消し、ブラウザの購読を外し、印を外す。サーバーから消せなくても購読は外す */
export function disablePush(playerId: string): Promise<PushResult> {
  return serial("disable", playerId, async ({ turn }): Promise<PushResult> => {
    await turn();
    try {
      const sub = await (await registration())?.pushManager.getSubscription();
      if (sub) await withdraw(playerId, sub);
    } catch {
      /* 外せなくても印は外す */
    }
    setReminderOn(false);
    return { state: "off" };
  });
}

/**
 * 有効にした購読を、アプリを開いたとき（と、引き継ぎでプレイヤーが変わったとき）にサーバーへ登録し直す。
 * 同じ購読なら上書きして期限（最後の登録から 400 日）を延ばし、プレイヤーが変わっていれば移す。
 * 許可が取り消されていた・購読が消えていたら印を外す。一時的な失敗（通信・429・5xx）はそのままにして
 * 次に開いたときに登録し直し、登録できない失敗（400・作り直しても 409 など）なら購読と印を外す
 * （期限を過ぎて後の操作に追い越されていたら外さない。今の購読と印は後の操作のもの）
 */
export function refreshPush(playerId: string): Promise<void> {
  return serial("refresh", playerId, async ({ turn, passed }) => {
    await turn();
    try {
      if (!reminderOn() || pushSupport() !== "supported") return;
      if (Notification.permission !== "granted") return setReminderOn(false);
      const reg = await registration();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return setReminderOn(false);
      try {
        await register(playerId, reg, sub, reminderOn);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500)) return;
        if (passed()) return;
        await dropSubscription(reg);
        setReminderOn(false);
      }
    } catch {
      /* 次に開いたときにまた試す */
    }
  });
}
