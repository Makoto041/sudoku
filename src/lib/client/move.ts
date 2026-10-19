import { LEGACY_HOST, SITE_ORIGIN } from "@/lib/site";
import { normalizeCode } from "@/lib/transfer-code";
import { reminderOn } from "./push";
import { loadStats } from "./stats";
import { KEYS, isPlainObject, load, loadByPrefix, save } from "./storage";

/** 前の本番の URL で開いているか（完全一致。プレビューやローカルは含めない） */
export const isLegacyHost = (hostname: string) => hostname === LEGACY_HOST;

/**
 * 旧 URL で、通知をオンにしたまま移るコードを発行したか。保存した true のときだけ。
 * 発行するときに旧 URL の通知の印は消えるので、発行し直したとき（新しい URL から戻ってもう一度押したなど）はこれで見る
 */
export const movedWithReminder = () => load<unknown>(KEYS.movedWithReminder) === true;

/** 通知をオンにしたまま移るコードを発行したことを覚える（旧 URL で通知をオンにし直すと消える。setReminderOn） */
export function markMovedWithReminder() {
  save(KEYS.movedWithReminder, true);
}

/**
 * この端末（開いている URL）に記録があるか。旧 URL で記録の無い端末だけを、新しい URL へそのまま移すのに使う。
 * キーの有無では決めない（開いただけで、名前の無いプレイヤー・実績・空の履歴を保存する）。
 * 見落とすと旧 URL の記録に戻れなくなるので、迷う種類は記録ありとみなす。壊れた保存データは記録なし
 */
export function hasLocalData(): boolean {
  const player = load<unknown>(KEYS.player);
  if (isPlainObject(player) && typeof player.name === "string" && player.name !== "") return true;
  if (Object.keys(loadStats()).length > 0) return true;
  if (load<unknown>(KEYS.free) !== null) return true;
  const practice = load<unknown>(KEYS.practice);
  if (isPlainObject(practice) && Object.values(practice).some((v) => Array.isArray(v) && v.length > 0))
    return true;
  if (loadByPrefix("sudoku:result:").length > 0 || loadByPrefix("sudoku:daily:").length > 0) return true;
  const history = load<unknown>(KEYS.historyCache);
  if (Array.isArray(history) && history.length > 0) return true;
  return reminderOn() || movedWithReminder();
}

/** 新しい URL で受け取るリンクの中身。code はコードの形が違えば null。push は旧 URL で通知をオンにしていたか */
export type MoveLink = { code: string | null; push: boolean };

/** fragment（#code=XXXXXXXX&push=1）を読む。code= が無ければ null（あれば、形が違っても URL から消す） */
export function parseMoveHash(hash: string): MoveLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  if (!params.has("code")) return null;
  return { code: normalizeCode(params.get("code")), push: params.get("push") === "1" };
}

const LEGACY_ORIGIN = `https://${LEGACY_HOST}`;

/**
 * 旧 URL のページから開かれたか（document.referrer の origin で見る）。受け取るシートは、このときだけ自動で開く
 * （ほかのページから送られたリンクで、1 回のタップでプレイヤーを差し替えられないように）。空・読めないときは false
 */
export function fromLegacy(referrer: string): boolean {
  try {
    return new URL(referrer).origin === LEGACY_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * 受け取るシートを自動で開いてよい読み込みか（PerformanceNavigationTiming の type）。新しく開いたとき（navigate）だけ。
 * 再読み込み・戻る/進むでは開かない（旧 URL から移った後に fragment だけを差し替えて読み込み直させると、
 * referrer が旧 URL のまま別のコードで開けてしまう）。取れないときも開かない
 */
export const navigationAllowsClaim = (type: string | undefined) => type === "navigate";

/**
 * 新しい URL で引き継ぎを開くリンク。コードは fragment に入れる
 * （クエリはサーバーのログや Referer に残る。fragment はサーバーに送られない）
 */
export const moveUrl = (code: string, push: boolean) =>
  `${SITE_ORIGIN}/#code=${code}${push ? "&push=1" : ""}`;

/** 記録の無い端末を移す先（同じパスとクエリ） */
export const legacyTarget = (pathname: string, search: string) => `${SITE_ORIGIN}${pathname}${search}`;
