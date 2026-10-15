import { KEYS, load, save } from "./storage";

export type Player = { id: string; name: string | null };

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // 古いブラウザ向け（RFC 4122 v4 形式）
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getPlayer(): Player {
  const stored = load<Player>(KEYS.player);
  if (stored?.id) return stored;
  const player = { id: uuid(), name: null };
  save(KEYS.player, player);
  return player;
}

export function setPlayerName(name: string): Player {
  const player = { ...getPlayer(), name };
  save(KEYS.player, player);
  return player;
}
