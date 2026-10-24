import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { countIp, ipCountsWithin, ipRateBuckets, withinIpLimit } from "./ip";
import { MemoryStore } from "./store";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** 枠の名前（テスト側で独立に書いたもの） */
const name = (text: string) => `ip:${sha256(text)}`;

describe("回数制限の IP の枠", () => {
  it("IPv4 と IPv4 射影は、その IPv4 の 1 つの枠", () => {
    const v4 = [{ name: name("198.51.100.9"), scale: 1 }];
    expect(ipRateBuckets("198.51.100.9")).toEqual(v4);
    expect(ipRateBuckets("::ffff:198.51.100.9")).toEqual(v4);
    expect(ipRateBuckets("::ffff:c633:6409")).toEqual(v4);
  });

  it("IPv6 は /64 と /48 の 2 つの枠で、/48 の上限は /64 の 8 倍。書き方が違っても同じ枠", () => {
    const expected = [
      { name: name("2001:db8:1:2::/64"), scale: 1 },
      { name: name("2001:db8:1::/48"), scale: 8 },
    ];
    for (const ip of [
      "2001:db8:1:2::1",
      "2001:0DB8:0001:0002:ffff:0:0:1",
      "2001:db8:1:2:aaaa:bbbb:cccc:dddd",
    ]) {
      expect([ip, ipRateBuckets(ip)]).toEqual([ip, expected]);
    }
    expect(ipRateBuckets("2001:db8:1:3::1")[1]).toEqual(expected[1]);
    expect(ipRateBuckets("2001:db8:1:3::1")[0]).not.toEqual(expected[0]);
  });

  it("ゾーン ID 付きの IPv6 は、ゾーン ID を落とした枠で数える（付け替えて別の枠にできない）", () => {
    const plain = ipRateBuckets("fe80::1");
    expect(plain).toHaveLength(2);
    for (const ip of ["fe80::1%eth0", "fe80::1%eth1", "FE80::1%25en0"]) {
      expect([ip, ipRateBuckets(ip)]).toEqual([ip, plain]);
    }
  });

  it("IP が無い・IP として読めない値は、固定の unknown の 1 つの枠", () => {
    for (const ip of [null, "", "not-an-ip", "1.2.3", "fe80::1%"]) {
      expect([ip, ipRateBuckets(ip)]).toEqual([ip, [{ name: "ip:unknown", scale: 1 }]]);
    }
  });

  it("枠の名前に生の IP を入れない", () => {
    const text = JSON.stringify([ipRateBuckets("203.0.113.7"), ipRateBuckets("2001:db8:1:2::1")]);
    for (const s of ["203.0.113.7", "2001:db8", "/64", "/48"]) expect(text).not.toContain(s);
  });
});

describe("withinIpLimit", () => {
  const T0 = Date.parse("2026-10-15T03:00:00Z");
  const rule = { limit: 3, windowSec: 60 * 60 };
  const count = (store: MemoryStore, ip: string | null) => withinIpLimit(store, "t:", ip, rule, T0);

  it("IPv4 は 1 つの枠で、上限の回数までは通し、次の 1 回で false。カウンタの名前は prefix に枠の名前を続けたもの", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) expect(await count(store, "203.0.113.7")).toBe(true);
    expect(await count(store, "203.0.113.7")).toBe(false);
    expect(await count(store, "203.0.113.8")).toBe(true);
    expect(store.rateWindowKeys().map((k) => k.replace(/:\d+$/, ""))).toEqual(
      [`sdk:push:rl:t:${name("203.0.113.7")}`, `sdk:push:rl:t:${name("203.0.113.8")}`].sort(),
    );
  });

  it("IPv6 は /64 の上限で断り、/64 を変えても /48 の上限（8 倍）は超えられない", async () => {
    const store = new MemoryStore();
    // /64 ごとに上限の 3 回まで。8 つの /64 で /48 の上限の 24 回に達する
    for (let n = 0; n < 8; n++) {
      for (let i = 0; i < 3; i++)
        expect([n, i, await count(store, `2001:db8:1:${n}::${i + 1}`)]).toEqual([n, i, true]);
      expect([n, await count(store, `2001:db8:1:${n}::99`)]).toEqual([n, false]);
    }
    // 新しい /64 でも、同じ /48 なら断る。別の /48 は通す
    expect(await count(store, "2001:db8:1:ff::1")).toBe(false);
    expect(await count(store, "2001:db8:2::1")).toBe(true);
  });

  it("/64 の上限で断った要求は /48 に数えない（1 つの /64 から送り続けて、同じ /48 の他人を断らせない）", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) await count(store, "2001:db8:1:1::1");
    for (let i = 0; i < 100; i++) expect(await count(store, "2001:db8:1:1::1")).toBe(false);
    // /48 は 3 回だけ数えているので、同じ /48 の別の /64 は通る
    for (let n = 2; n < 9; n++) {
      for (let i = 0; i < 3; i++)
        expect([n, i, await count(store, `2001:db8:1:${n}::1`)]).toEqual([n, i, true]);
    }
    expect(await count(store, "2001:db8:1:9::1")).toBe(false);
  });
});

describe("countIp と ipCountsWithin", () => {
  const T0 = Date.parse("2026-10-15T03:00:00Z");
  const rule = { limit: 10, windowSec: 60 * 60 };

  it("数えた枠の回数と倍率を返し、別の上限（倍率を掛けたもの）で判定し直せる", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 2; i++) await countIp(store, "t:", "203.0.113.7", rule, T0);
    const v4 = await countIp(store, "t:", "203.0.113.7", rule, T0);
    expect(v4).toEqual({ within: true, counts: [{ count: 3, scale: 1 }] });
    expect([ipCountsWithin(v4.counts, 3), ipCountsWithin(v4.counts, 2)]).toEqual([true, false]);

    // /48 は 8 倍: 上限 2 なら /48 は 16 回まで。/64 を変えると 16 回目までは通り、17 回目で超える
    let last = await countIp(store, "t:", "2001:db8:1:0::1", rule, T0);
    for (let i = 1; i <= 16; i++) {
      expect([i, ipCountsWithin(last.counts, 2)]).toEqual([i, true]);
      last = await countIp(store, "t:", `2001:db8:1:${i}::1`, rule, T0);
    }
    expect(last).toEqual({
      within: true,
      counts: [
        { count: 1, scale: 1 },
        { count: 17, scale: 8 },
      ],
    });
    expect(ipCountsWithin(last.counts, 2)).toBe(false);
  });

  it("上限を超えた枠で止め、その先の枠は数えない", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) await countIp(store, "t:", "2001:db8:1:1::1", rule, T0);
    expect(await countIp(store, "t:", "2001:db8:1:1::1", rule, T0)).toEqual({
      within: false,
      counts: [{ count: 11, scale: 1 }],
    });
  });
});
