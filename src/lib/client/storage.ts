/** localStorage はプライベートブラウズなどで使えないことがあるので、すべて try/catch で包む */
export function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できなくても遊べる */
  }
}

export function remove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* noop */
  }
}

/** 配列でないオブジェクトか（保存データや受け取った記録を検証するときに使う） */
export const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** 前方一致するキーと値を集める */
export function loadByPrefix<T>(prefix: string): [string, T][] {
  const out: [string, T][] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix)) continue;
      const v = load<T>(key);
      if (v !== null) out.push([key, v]);
    }
  } catch {
    /* 使えなければ空 */
  }
  return out;
}

export const KEYS = {
  player: "sudoku:player",
  settings: "sudoku:settings",
  free: "sudoku:free",
  daily: (date: string, difficulty: string) => `sudoku:daily:${date}:${difficulty}`,
  dailyResult: (date: string, difficulty: string) => `sudoku:result:${date}:${difficulty}`,
  stats: "sudoku:stats",
  installHint: "sudoku:install-hint",
  clockOffset: "sudoku:clock-offset",
  historyCache: "sudoku:history",
  /** 手筋の練習の進み具合（端末内だけ。引き継ぎには含めない） */
  practice: "sudoku:practice",
  /** ホームの遊び方の案内を閉じたか（端末内だけ。引き継ぎには含めない） */
  howto: "sudoku:howto",
};
