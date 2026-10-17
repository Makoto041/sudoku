import type { Achievement } from "@/lib/client/achievements";

/** クリアや正解で新しく解除した実績を「実績: A、B」の 1 行で出す。無ければ何も出さない */
export function AchievementLine({ fresh }: { fresh: readonly Achievement[] }) {
  if (!fresh.length) return null;
  return <span className="ach-line">実績: {fresh.map((a) => a.name).join("、")}</span>;
}
