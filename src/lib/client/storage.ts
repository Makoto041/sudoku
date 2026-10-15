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

export const KEYS = {
  player: "sudoku:player",
  settings: "sudoku:settings",
  free: "sudoku:free",
  daily: (date: string, difficulty: string) => `sudoku:daily:${date}:${difficulty}`,
  dailyResult: (date: string, difficulty: string) => `sudoku:result:${date}:${difficulty}`,
  stats: "sudoku:stats",
  installHint: "sudoku:install-hint",
  clockOffset: "sudoku:clock-offset",
};
