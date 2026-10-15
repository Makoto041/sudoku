# 数独

効果音が気持ちいい、シンプルな数独。毎日の「今日の一問」で、全員が同じ問題を解いてタイムを競えます。
iPhone では Safari の共有メニューから「ホーム画面に追加」すると、アプリとして遊べます（PWA）。

**プレイ: https://sudoku-xi-five.vercel.app**

## 遊び方

- **今日の一問**: 難易度ごとに 1 日 1 問。全員が同じ問題で、最初のクリアタイムがランキングに載ります。日付は日本時間 0 時に切り替わります。
- **フリープレイ**: 好きな難易度で何問でも。ヒントと一時停止が使えます。オフラインでも遊べます。
- 操作: マスをタップ → 数字。メモはメモを ON にしてから数字。キーボードでは 1〜9、Shift+数字でメモ、矢印で移動、N でメモ切替、Backspace で消す、Z で元に戻す。

## しくみ

| 場所                 | 内容                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `src/lib/sudoku/`    | 盤面の基本処理、解答探索（ビットマスク＋MRV）、人の手筋による難易度判定、シードから決まる問題生成 |
| `src/lib/game/`      | ゲームの状態遷移（純粋関数）。入力・メモ・元に戻す・ヒント・クリア判定                            |
| `src/lib/audio.ts`   | 効果音。Web Audio でその場で合成（音声ファイルなし）。数字ごとにペンタトニックの音程              |
| `src/lib/haptics.ts` | 触覚。Android は Vibration API、iOS 18 以降の Safari は switch 型チェックボックスの触覚           |
| `src/lib/server/`    | ランキング API の中身。保存先は Upstash Redis（ローカルとテストはメモリ）                         |
| `src/app/api/`       | Route Handlers（`/api/daily/start`, `/api/daily/submit`, `/api/leaderboard`, `/api/player`）      |
| `public/sw.js`       | Service Worker。静的ファイルをキャッシュし、オフラインでもフリープレイを開ける                    |

### ランキングの公正さ

- 今日の一問は日付と難易度から決まり、サーバーが同じ問題を作り直して答えを照合します。解答はブラウザに送りません。
- 時間はサーバーが計測します（開始を受け付けた時刻から、正しい解答を受け取った時刻まで）。一時停止はできません。
- 同じプレイヤーが開始し直しても最初の開始時刻が使われ、記録は最初のクリアの 1 回だけです。15 秒未満のクリアは記録しません。
- プレイヤーは端末ごとの匿名 ID とニックネームで識別します。ログインが無いので、ID を作り直す不正までは防げません。

## 開発

```bash
npm install
npm run dev          # http://localhost:3000（ランキングはメモリに保存）
npm test             # 単体テスト（vitest）
npm run test:e2e     # E2E（Playwright: iPhone 相当の WebKit とデスクトップ Chrome）
npm run typecheck
npm run gen:icons    # アイコンを書き出し直す
```

## デプロイ

Vercel（Next.js）にデプロイし、Vercel Marketplace の **Upstash for Redis** をプロジェクトに接続します。
接続すると `KV_REST_API_URL` / `KV_REST_API_TOKEN` が自動で設定されます（`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` でも可）。
環境変数を追加・変更したあとは再デプロイが必要です。
