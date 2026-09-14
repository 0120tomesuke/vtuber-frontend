# Holo Alpha — Cloudflare無料構成

このアプリはCloudflare Workers、D1、Cronで動作します。常駐NodeサーバーやRenderは使いません。Cronは1分ごとに配信情報を同期します。

Holodexを主データ源にし、登録チャンネルのYouTube RSSとYouTube Data APIで取りこぼしを補完します。前回の状態をD1に保存するため、配信終了、タイトル・開始時刻変更、通知済み判定をWorkerの実行をまたいで維持します。通知メールは無料のGAS中継、Gmail API、Resendの順に選択できます。

## 初回セットアップ

1. `npm install`
2. `npx wrangler login` を実行し、Cloudflareへログインする。
3. `npm run db:create` を実行する。表示された `database_id` を `wrangler.jsonc` の `REPLACE_WITH_D1_DATABASE_ID` と置き換える。
4. `npm run db:migrate` を実行する。
5. CloudflareダッシュボードのWorker設定で、次のSecretsを登録する。

   必須: `HOLODEX_API_KEY`, `GOOGLE_SHEETS_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON`

   補完機能: `YOUTUBE_API_KEY`

   メール通知（無料・恒久運用）: `GAS_MAIL_RELAY_URL`, `GAS_MAIL_RELAY_TOKEN`, `NOTIFICATION_EMAIL`

   メール通知（Gmail API・テスト用）: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN`, `GMAIL_SENDER_EMAIL`, `NOTIFICATION_EMAIL`

   メール通知（Resend）: `RESEND_API_KEY`, `EMAIL_FROM`, `NOTIFICATION_EMAIL`

   管理画面: `ADMIN_PASSWORD`（十分に長い任意のパスワード）

6. Googleサービスアカウントのメールアドレスを、対象スプレッドシートの編集者に追加する。
7. `npm run deploy` を実行する。

無料D1の枠・Cloudflareの利用上限はアカウントの最新規約に従います。APIキーはGitHubへ絶対にコミットしないでください。

## GAS MailApp中継で無料・恒久送信する

Cloudflareは監視・通知判定だけを担当し、メール送信だけをGAS Webアプリへ委譲します。GASは通知発生時にだけ実行されるため、定期監視の実行回数や実行時間には影響しません。個人GmailのMailAppは送信先100件/日までです。

1. Apps Scriptで新しいプロジェクトを作成し、[`gas/mail-relay.gs`](gas/mail-relay.gs) の内容を貼り付ける。
2. プロジェクト設定の **スクリプト プロパティ** に `MAIL_RELAY_TOKEN` を追加する。値は十分に長いランダム文字列にする。
3. **デプロイ > 新しいデプロイ > ウェブアプリ** を選び、次を設定する。

   - 実行するユーザー: **自分**
   - アクセスできるユーザー: **全員**

4. 初回承認後、末尾が `/exec` のURLをコピーする。
5. Cloudflare WorkerのSecretsに `GAS_MAIL_RELAY_URL` と `GAS_MAIL_RELAY_TOKEN` を登録する。前者には `/exec` URL、後者には手順2と同じトークンを入れる。

トークンが一致しないリクエストはGAS側で拒否されるため、Webアプリを公開しても第三者がメール送信に利用することはできません。GAS中継が設定されると、Gmail APIとResendより優先されます。

## Gmail APIで無料送信する（テスト用）

Gmail APIを設定すると、独自ドメインなしで任意のGmailアドレスへ通知できます。ただしOAuthアプリがテスト状態では更新トークンが約7日で失効します。恒久運用には所有確認済み独自ドメインと本番公開が必要です。GAS中継を使えない場合だけ利用してください。

1. Google Cloud Consoleで既存プロジェクトの **Gmail API** を有効化する。
2. **OAuth同意画面** を設定する。個人専用アプリでも、常時運用前には公開ステータスを **本番** に変更する。テスト状態では更新トークンが7日で失効する。
3. **認証情報** から「OAuth クライアントID」→「デスクトップアプリ」を作成する。
4. PowerShellで一時的にクライアントIDとシークレットを設定して、認可補助スクリプトを実行する。

   ```powershell
   $env:GMAIL_OAUTH_CLIENT_ID="作成したクライアントID"
   $env:GMAIL_OAUTH_CLIENT_SECRET="作成したクライアントシークレット"
   node scripts/authorize-gmail.mjs
   ```

5. 表示されたURLをブラウザで開き、送信元にするGmailアカウントで `gmail.send` 権限を許可する。ターミナルに表示される更新トークンをコピーする。
6. Cloudflare WorkerのSecretsへ `GMAIL_OAUTH_CLIENT_ID`、`GMAIL_OAUTH_CLIENT_SECRET`、`GMAIL_OAUTH_REFRESH_TOKEN` を登録し、通常の変数へ `GMAIL_SENDER_EMAIL`（認可した送信元Gmailアドレス）を登録する。

更新トークンとクライアントシークレットは、絶対にGitHubへ保存しないでください。

## Cloudflare移行後のデータ運用

初回のD1移行後、スプレッドシートのマスタは一度だけD1へ取り込まれます。その後のチャンネル・お気に入り・除外ワード・イベントキーワード・通知設定は、サイトの「管理・通知設定」から変更できます。通常監視ではGoogle Sheetsを読み書きしないため、同接バッファシートも肥大化しません。

配信・通知・同接の時系列データはD1に保存され、終了配信・監視ログ・通知ログ・同接推移は90日間保持されます。同接は5分ごとに記録し、RSSは20チャンネルずつ毎分確認します。監視そのものは毎分ですが、D1には前回との差分だけを書き込みます。正常な監視履歴は15分単位に集約し、失敗は毎回記録します。これにより、D1 Freeの1日10万書込枠を消費しない構成です。

Holodexのゲスト情報（mentions）はRSSとは別に継続同期します。配信中・予定・終了済みの追跡配信を毎分巡回して、途中参加したゲストをD1とFAV表示へ反映します。推しが新たにゲストとして検知された配信はFAV対象になり、ゲスト追加・変更は通常の「変更通知」対象です。
