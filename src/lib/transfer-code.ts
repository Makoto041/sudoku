// 紛らわしい 0/O/1/I を除いた 32 文字。8 文字で約 1 兆通り
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

/** 入力されたコードを整える（小文字・空白・ハイフンを許す） */
export function normalizeCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

/** 画面に出す形（ABCD-EFGH） */
export const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;
