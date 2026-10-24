import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { RankingStore } from "./store";

// ranking・push・auth から使う。ranking と push を import しない（ranking → push の循環で、ランキングの route に
// web-push が読み込まれるため）

/** IPv6 アドレスを 16 ビットずつ 8 つに分ける。読めないもの（ゾーン ID 付きなど）は null */
export function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  let text = address;
  const tail: number[] = [];
  // 末尾の IPv4 の表記（::ffff:1.2.3.4 など）は 16 ビット 2 つにする
  const dotted = /:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    tail.push((a << 8) | b, (c << 8) | d);
    text = text.slice(0, dotted.index + 1);
    if (!text.endsWith("::")) text = text.slice(0, -1);
  }
  const groups = (s: string) => (s === "" ? [] : s.split(":").map((h) => parseInt(h, 16)));
  const halves = text.split("::");
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const zeros = halves.length === 2 ? 8 - head.length - rest.length - tail.length : 0;
  const words = [...head, ...Array<number>(Math.max(0, zeros)).fill(0), ...rest, ...tail];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff)
    ? words
    : null;
}

/** IPv6 の /48 の枠の上限は、/64 の枠の上限のこの倍 */
export const IPV6_48_SCALE = 8;

/** 回数制限の IP の枠。name はカウンタの名前の末尾、scale は上限の倍率 */
type IpBucket = { name: string; scale: number };

const bucket = (text: string, scale = 1): IpBucket => ({
  name: `ip:${createHash("sha256").update(text).digest("hex")}`,
  scale,
});

/**
 * 回数制限の IP の枠。生の IP を保存しないよう SHA-256 にする。
 * - IPv4 と IPv4 射影（::ffff:a.b.c.d）は、その IPv4 の 1 つ
 * - IPv6 は /64（回線や端末ごとに配られることが多い）と、その倍の上限の /48 の 2 つ。/64 だけでは、/48 を配る回線や
 *   トンネルで /64 を使い分けて回避でき、/48 だけでは、携帯や ISP の同じ /48 の他人をまとめて断ってしまうため。
 *   ゾーン ID（%eth0 など）は落とす（付け替えて別の枠にさせない）
 * - 取れない・読めないものは固定の unknown の 1 つ（ヘッダーを外して回避させない）
 */
export function ipRateBuckets(ip: string | null): IpBucket[] {
  if (ip && isIP(ip) === 4) return [bucket(ip)];
  const words = ip && isIP(ip) === 6 ? ipv6Words(ip.replace(/%.*$/, "")) : null;
  if (!words) return [{ name: "ip:unknown", scale: 1 }];
  const hex = (n: number) =>
    words
      .slice(0, n)
      .map((w) => w.toString(16))
      .join(":");
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    return [bucket(`${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`)];
  }
  return [bucket(`${hex(4)}::/64`), bucket(`${hex(3)}::/48`, IPV6_48_SCALE)];
}

/**
 * 要求元の IP の枠を、細かい順に 1 回ずつ数える。どれかの枠で上限（rule.limit × 枠の倍率）を超えたら false を返し、
 * その先の枠は数えない（/64 で断った要求は /48 に数えない）。カウンタの名前は prefix に枠の名前を続けたもの
 */
export async function withinIpLimit(
  store: Pick<RankingStore, "incrRateWindow">,
  prefix: string,
  ip: string | null,
  rule: { limit: number; windowSec: number },
  now: number,
): Promise<boolean> {
  for (const { name, scale } of ipRateBuckets(ip)) {
    if ((await store.incrRateWindow(`${prefix}${name}`, rule.windowSec, now)) > rule.limit * scale) {
      return false;
    }
  }
  return true;
}
