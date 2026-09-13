# Holo Alpha — Cloudflare無料構成

このアプリはCloudflare Workers、D1、Cronで動作します。常駐NodeサーバーやRenderは使いません。Cronは1分ごとに配信情報を同期します。

## 初回セットアップ

1. `npm install`
2. `npx wrangler login` を実行し、Cloudflareへログインする。
3. `npm run db:create` を実行する。表示された `database_id` を `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` と置き換える。
4. `npm run db:migrate` を実行する。
5. CloudflareダッシュボードのWorker設定で、次のSecretsを登録する。

   `HOLODEX_API_KEY`, `YOUTUBE_API_KEY`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `RESEND_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_EMAIL`

6. Googleサービスアカウントのメールアドレスを、対象スプレッドシートの編集者に追加する。
7. `npm run deploy` を実行する。

無料D1の枠・Cloudflareの利用上限はアカウントの最新規約に従います。APIキーはGitHubへ絶対にコミットしないでください。
