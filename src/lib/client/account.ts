import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { ApiError, api, type AccountView } from "./api";
import { adoptPlayer, type Player } from "./player";
import { combineStats, loadStats, mergeStats, type Stats } from "./stats";
import { KEYS, isPlainObject, remove, removeByPrefix } from "./storage";

export type { AccountView };

/**
 * アカウントの状態
 * - loading：確かめている途中（設定に項目を出さない。引き継ぎのコードも入れさせない）
 * - unavailable：サーバーにアカウントの設定が無い（503。旧 URL・プレビューを含む）か、確かめられなかった
 *   （設定に項目を出さない）。retry は通信の失敗などで、ホームに戻ったときに確かめ直す
 * - signed-out：ログインしていない
 * - signed-in：ログイン中
 */
export type AccountState =
  | { status: "loading" }
  | { status: "unavailable"; retry: boolean }
  | { status: "signed-out" }
  | { status: "signed-in"; account: AccountView };

/** この端末（ブラウザ）でパスキーを使えるか */
export const passkeySupported = () => browserSupportsWebAuthn();

/** サーバーから受け取ったアカウント。形が違えば null */
export function parseAccount(value: unknown): AccountView | null {
  if (!isPlainObject(value) || typeof value.playerId !== "string" || !value.playerId) return null;
  return {
    playerId: value.playerId,
    name: typeof value.name === "string" && value.name ? value.name : null,
    passkeys: Number.isFinite(value.passkeys) ? (value.passkeys as number) : 0,
    stats: value.stats ?? null,
  };
}

function accountOf(res: { account?: unknown }): AccountView {
  const account = parseAccount(res.account);
  if (!account) throw new ApiError(500, "invalid account");
  return account;
}

/** ログインしていない（セッションが無い・切れた）ことを示すエラーか */
export const isSignedOutError = (err: unknown) => err instanceof ApiError && err.status === 401;

/** ログインの状態を確かめる。失敗しても例外にしない */
export async function loadAccount(): Promise<AccountState> {
  try {
    const { account } = await api.me();
    if (account === null) return { status: "signed-out" };
    const view = parseAccount(account);
    return view ? { status: "signed-in", account: view } : { status: "unavailable", retry: false };
  } catch (err) {
    const retry =
      err instanceof ApiError ? err.status === 0 || (err.status >= 500 && err.status !== 503) : true;
    return { status: "unavailable", retry };
  }
}

/** 先取りした options を使う期限（サーバーの challenge は 300 秒。押してから送るまでの余裕を見る） */
export const OPTIONS_MAX_AGE_MS = 4 * 60_000;

type Kind = "signup" | "login" | "add";

/**
 * 先取りした options。key は signup では端末のプレイヤー ID、add ではログイン中のアカウントのプレイヤー ID
 * （ほかのプレイヤー・アカウントの options を使わない）、login では ""。result は取り終えたら入る
 */
type Slot = {
  key: string;
  at: number;
  promise: Promise<void>;
  result?: { options: unknown } | { error: unknown };
};

const slots = new Map<Kind, Slot>();

function fetchOptions(kind: Kind, key: string): Promise<{ options: unknown }> {
  if (kind === "signup") return api.signupOptions(key);
  if (kind === "login") return api.loginOptions();
  return api.passkeyOptions();
}

/**
 * 取り直しても変わらない失敗か（409：プレイヤーが紐づき済み・パスキーが上限）。
 * キーが変わるか、ログアウト・削除で忘れるまで取り直さない
 */
const lasting = (err: unknown) => err instanceof ApiError && err.status === 409;

/**
 * 先取りした options の状態（使えるかの判定はここだけ）。
 * - ready：使える
 * - pending：取っている途中
 * - failed：取れなかった（lasting なら取り直さない）
 * - null：無い・別のキー・期限切れ（取り直す）
 */
function lookup(kind: Kind, key: string, now: number) {
  const slot = slots.get(kind);
  if (!slot || slot.key !== key) return null;
  if (!slot.result) return { state: "pending" } as const;
  if ("error" in slot.result) return { state: "failed", error: slot.result.error } as const;
  return now - slot.at < OPTIONS_MAX_AGE_MS
    ? ({ state: "ready", options: slot.result.options } as const)
    : null;
}

/**
 * パスキーの操作の options を先取りする（押してから取ると、取る間の await で Safari がパスキーの画面を出さない）。
 * 取るたびに challenge の回数の制限に数えるので、取るのはシートを開いたとき・操作の後・押して始められなかったときだけ。
 * 取っている途中・使える・取り直しても変わらない失敗なら取り直さない
 */
function prepare(kind: Kind, key: string, now = Date.now()): Promise<void> {
  const found = lookup(kind, key, now);
  if (found && (found.state !== "failed" || lasting(found.error))) return slots.get(kind)!.promise;
  const slot: Slot = { key, at: now, promise: Promise.resolve() };
  slot.promise = fetchOptions(kind, key).then(
    ({ options }) => void (slot.result = { options }),
    (error: unknown) => void (slot.result = { error }),
  );
  slots.set(kind, slot);
  return slot.promise;
}

/** アカウントを作る options を先取りする（端末のプレイヤー ID ごと） */
export const prepareSignup = (playerId: string) => prepare("signup", playerId);
/** ログインの options を先取りする */
export const prepareLogin = () => prepare("login", "");
/** パスキーを足す options を先取りする（ログイン中のアカウントのプレイヤー ID ごと） */
export const preparePasskey = (accountPlayerId: string) => prepare("add", accountPlayerId);

/** options がまだ取れていない・期限切れで、パスキーの操作を始めなかった（取り直したので、もう一度押せば始められる） */
export class NotReadyError extends Error {
  constructor() {
    super("not ready");
    this.name = "NotReadyError";
  }
}

/**
 * 先取りした options でパスキーの操作を始める。押した操作の処理の中で、最初の await より前に呼ばれるようにする
 * （この関数も、呼ぶ側も、ここまでに await しない）。
 * 始められないときは取り直して（prepare の条件で）、取れなかった理由（まだ・期限切れなら NotReadyError）で失敗する。
 * パスキーの応答を得たら options は使ったものとして捨てる（キャンセルなどのときは、challenge は使われていないので残す）
 */
async function ceremony<O, R>(kind: Kind, key: string, start: (options: O) => Promise<R>): Promise<R> {
  const now = Date.now();
  const found = lookup(kind, key, now);
  if (found?.state !== "ready") {
    void prepare(kind, key, now);
    throw found?.state === "failed" ? found.error : new NotReadyError();
  }
  const slot = slots.get(kind);
  const response = await start(found.options as O);
  if (slots.get(kind) === slot) slots.delete(kind);
  return response;
}

/** パスキーを作ってアカウントを作り、ログインする（端末のプレイヤーを紐づける） */
export async function createAccount(playerId: string): Promise<AccountView> {
  const response = await ceremony("signup", playerId, (o: PublicKeyCredentialCreationOptionsJSON) =>
    startRegistration({ optionsJSON: o }),
  );
  return accountOf(await api.signupVerify(response));
}

/** 端末に保存されたパスキーでログインする */
export async function login(): Promise<AccountView> {
  const response = await ceremony("login", "", (o: PublicKeyCredentialRequestOptionsJSON) =>
    startAuthentication({ optionsJSON: o }),
  );
  return accountOf(await api.loginVerify(response));
}

/** ログイン中のアカウント（accountPlayerId はそのプレイヤー ID）にパスキーを足す */
export async function addPasskey(accountPlayerId: string): Promise<AccountView> {
  const response = await ceremony("add", accountPlayerId, (o: PublicKeyCredentialCreationOptionsJSON) =>
    startRegistration({ optionsJSON: o }),
  );
  return accountOf(await api.passkeyVerify(response));
}

/** 画面に出す操作の種類（失敗の文言を選ぶのに使う） */
export type AccountAction = "signup" | "login" | "add" | "other";

const RETRY = "もう一度試してください";

const FAILED: Record<AccountAction, string> = {
  signup: "作成できませんでした",
  login: "ログインできませんでした",
  add: "追加できませんでした",
  other: RETRY,
};

/**
 * 失敗を画面の文言に写す。キャンセル（パスキーの画面を閉じた・時間切れ・別の操作で止めた）は null（何も出さない）。
 * サーバーのエラーは応答の error（server/auth.ts の RankingError の文言）で見分ける
 */
export function accountError(err: unknown, action: AccountAction): string | null {
  if (err instanceof ApiError) {
    if (err.status === 0) return "オフラインです";
    if (err.status === 429) return "しばらくしてからもう一度試してください";
    // セッションが切れていた。画面はログインしていない表示に替わる（ログインの失敗は login failed）
    if (err.message === "not signed in") return null;
    if (err.message === "already linked") return "このプレイヤーのアカウントがあります。ログインしてください";
    if (err.message === "credential exists") return "このパスキーは登録済みです";
    if (err.message === "challenge expired" || err.message === "invalid challenge") return RETRY;
    return FAILED[action];
  }
  if (err instanceof NotReadyError) return RETRY;
  // パスキーの操作の失敗。@simplewebauthn/browser の WebAuthnError は元のエラーの名前を持つ
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return null;
  // 登録済みのパスキー（追加で excludeCredentials に当たった）
  if (name === "InvalidStateError") return "このパスキーは登録済みです";
  return FAILED[action];
}

/** 最後にアカウントと合わせた記録（送っても変わらない記録を送らないため。端末には保存しない） */
let synced: { playerId: string; stats: Stats } | null = null;
/** 送っている途中の記録（失敗すると reject する） */
let syncing: Promise<void> | null = null;
/** ログアウト・削除で増やす。それより前に送った記録の応答は端末に入れない */
let epoch = 0;

const canon = (s: Stats) => JSON.stringify(combineStats({}, s));

/** アカウントの記録として覚える（送っても変わらない記録を送らないため） */
function remember(playerId: string, stats: unknown) {
  synced = { playerId, stats: combineStats({}, stats) };
}

/** 同期の状態と先取りした options を忘れる（送っている途中の記録の応答は端末に入れない） */
function forget() {
  synced = null;
  syncing = null;
  epoch++;
  slots.clear();
}

/**
 * 端末の記録（フリープレイ）をアカウントに送り、合わせた記録を端末にも入れる。失敗したら reject する。
 * 送っている途中ならその結果を返す。記録が無い・送ってもアカウントの記録が変わらないときは送らない
 */
function sendStats(playerId: string): Promise<void> {
  if (syncing) return syncing;
  const local = loadStats();
  if (Object.keys(local).length === 0) return Promise.resolve();
  if (synced?.playerId === playerId && canon(combineStats(synced.stats, local)) === canon(synced.stats)) {
    return Promise.resolve();
  }
  const at = epoch;
  const sending: Promise<void> = api
    .putStats(local)
    .then(({ stats }) => {
      if (at !== epoch) return;
      mergeStats(stats);
      remember(playerId, stats);
    })
    .finally(() => {
      if (syncing === sending) syncing = null;
    });
  syncing = sending;
  return sending;
}

/**
 * 記録を同期する（ホームに戻るたびに呼ぶ）。送っている途中・送っても変わらないときは送らない（回数の制限に掛からないように）。
 * 失敗は無視する（次に呼んだときに送り直す）
 */
export function syncStats(playerId: string): Promise<void> {
  return sendStats(playerId).catch(() => {});
}

/**
 * ログインしたアカウントに端末を合わせる（ログイン・作成の直後と、開いたときにログイン中なら）。
 * 1. 端末のプレイヤーがアカウントのプレイヤーと違えば、端末のプレイヤーの今日の一問の履歴をアカウントに写す
 *    （失敗しても切り替える。紐づき済みのプレイヤーからはサーバーが写さない）
 * 2. 端末のプレイヤーをアカウントのプレイヤーにする。名前はアカウントのもの（同じプレイヤーで、サーバーに名前が無ければ端末の名前）
 * 3. アカウントの記録を端末の記録と合わせ、端末の記録をアカウントに送る
 */
export async function applyAccount(account: AccountView, device: Player): Promise<Player> {
  const same = device.id === account.playerId;
  if (!same) await api.merge(device.id).catch(() => {});
  const player = adoptPlayer(account.playerId, account.name ?? (same ? device.name : null));
  mergeStats(account.stats);
  remember(account.playerId, account.stats);
  await syncStats(account.playerId);
  return player;
}

/** ログアウトで消す端末の記録。設定・途中のフリープレイ・練習の進み具合・案内・通知の印などは残す */
const RESET_KEYS = [KEYS.player, KEYS.stats, KEYS.historyCache, KEYS.achievements];
const RESET_PREFIXES = ["sudoku:result:", "sudoku:daily:"];

/** 端末の記録（プレイヤー・フリープレイの記録・履歴・実績・今日の一問の結果と途中の盤面）を消す */
export function resetDevice() {
  for (const key of RESET_KEYS) remove(key);
  for (const prefix of RESET_PREFIXES) removeByPrefix(prefix);
  forget();
}

/**
 * この端末をログアウトし、端末の記録を消す（次に getPlayer で新しいプレイヤーになる）。
 * 消す前に、まだ送っていない記録をアカウントに送る。送れなければ（通信の失敗・429 など）ログアウトせず、何も消さずに失敗する。
 * 401（もうログインしていない）なら送れなくても消す（送れなかった分は失われる）
 */
export async function logoutDevice(accountPlayerId: string): Promise<void> {
  try {
    // 送っている途中のものが失敗していれば、ここで失敗する。終わった後に増えた分も送る
    if (syncing) await syncing;
    await sendStats(accountPlayerId);
    await api.logout("this");
  } catch (err) {
    if (!isSignedOutError(err)) throw err;
  }
  resetDevice();
}

/** この端末以外のセッションを消す */
export async function logoutOthers(): Promise<void> {
  await api.logout("others");
}

/**
 * アカウントを消す。端末の記録とプレイヤーは残す（そのまま遊べる）。
 * 401（この端末のセッションが無い。ほかの端末のログアウトや期限切れで消えた）なら、アカウントは残っていても
 * この端末からは消せないので、ログインしていないものとして扱う（ログインし直せば消せる）
 */
export async function deleteAccount(): Promise<void> {
  try {
    await api.deleteAccount();
  } catch (err) {
    if (!isSignedOutError(err)) throw err;
  }
  forget();
}
