import { KEYS, load, save } from "./storage";

/**
 * ホームの遊び方の案内を閉じたか（遊び方を開いたときも閉じたことにする）。
 * 保存した true のときだけ閉じたとみなし、無い・壊れている・読めないときは案内を出す
 */
export const howtoSeen = () => load<unknown>(KEYS.howto) === true;

export function markHowtoSeen() {
  save(KEYS.howto, true);
}
