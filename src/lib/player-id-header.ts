/**
 * GET の要求で playerId を送るヘッダー（端末とサーバーで共通）。playerId は持ち主を示す秘密なので、
 * アクセスログ・ブラウザの履歴・Referer に残るクエリには入れない（README の「GET での playerId の受け渡し」）
 */
export const PLAYER_ID_HEADER = "x-player-id";
