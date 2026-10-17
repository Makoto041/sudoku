import { beforeEach, vi } from "vitest";

/**
 * テスト用：localStorage をメモリで置き換え、テストごとに空にする（vitest は Node で動くので localStorage が無い）。
 * 中身の store と、置き換えに使った memory（別の物に差し替えたあとで戻すため）を返す
 */
export function installMemoryStorage() {
  const store = new Map<string, string>();
  const memory = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", memory);
  beforeEach(() => store.clear());
  return { store, memory };
}
