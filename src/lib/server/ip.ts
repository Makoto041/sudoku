import { createHash } from "node:crypto";
import { isIP } from "node:net";

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

/**
 * 回数制限のカウンタの名前にする IP。生の IP を保存しないよう SHA-256 にする。IPv6 は /48 ごとにまとめる
 * （/48 を配る回線やトンネルでは、/64 を 65,536 個使い分けて制限を回避できるため）。
 * IPv4 射影（::ffff:a.b.c.d）は IPv4 として扱う。取れなければ固定の unknown（ヘッダーを外して回避させない）
 */
export function ipRateName(ip: string | null): string {
  if (!ip || !isIP(ip)) return "ip:unknown";
  let bucket = ip.toLowerCase();
  const words = isIP(ip) === 6 ? ipv6Words(ip) : null;
  if (words && words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    bucket = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
  } else if (words) {
    const prefix = words.slice(0, 3).map((w) => w.toString(16));
    bucket = `${prefix.join(":")}::/48`;
  }
  return `ip:${createHash("sha256").update(bucket).digest("hex")}`;
}
