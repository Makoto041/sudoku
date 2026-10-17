import { describe, expect, it, vi } from "vitest";
import { howtoSeen, markHowtoSeen } from "./howto";
import { installMemoryStorage } from "./memoryStorage";
import { KEYS } from "./storage";

const { store, memory } = installMemoryStorage();

describe("遊び方の案内", () => {
  it("閉じるまでは出し、閉じたら出さない。案内の保存先だけに書く", () => {
    expect(howtoSeen()).toBe(false);
    markHowtoSeen();
    expect(howtoSeen()).toBe(true);
    expect([...store.keys()]).toEqual([KEYS.howto]);
  });

  it("true 以外の保存データ（壊れた値・別の型）は閉じていないものとして読む", () => {
    for (const raw of ["{", "", "null", "false", "1", '"true"', "[]", "{}"]) {
      store.set(KEYS.howto, raw);
      expect(howtoSeen(), raw).toBe(false);
    }
  });

  it("localStorage が使えなくても、読み書きで落ちない", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    try {
      expect(howtoSeen()).toBe(false);
      expect(() => markHowtoSeen()).not.toThrow();
    } finally {
      vi.stubGlobal("localStorage", memory);
    }
  });
});
