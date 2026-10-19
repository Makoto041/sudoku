/**
 * 本番の URL。URL を変えるときはここを変える
 * （パスキーを入れるときは、RP ID と WEBAUTHN_ORIGIN もこれに合わせる）
 */
export const SITE_ORIGIN = "https://nanpure-game.vercel.app";

/** 画面に出す本番のホスト名 */
export const SITE_HOST = new URL(SITE_ORIGIN).host;

/**
 * 前の本番のホスト名。同じデプロイが配るので、開いた端末で見分けて新しい URL へ案内する
 * （プレビューやローカルはこの名前と一致しないので、案内しない）
 */
export const LEGACY_HOST = "sudoku-xi-five.vercel.app";
