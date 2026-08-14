# kpw-web

かめぱわぁ〜るどガイドのAstroサイト、WYSIWYGエディター、Discord権限連携APIです。原稿は [KamePowerWorld/kpw-docs](https://github.com/KamePowerWorld/kpw-docs) で管理します。

本番URL: [https://docs.kamesuta.com](https://docs.kamesuta.com)

## ローカル開発

`kpw-web`と`kpw-docs`を同じ親ディレクトリへ置きます。

```bash
npm ci
npm run dev
```

別の場所に原稿がある場合は`KPW_DOCS_DIR=/path/to/kpw-docs npm run dev`を使用します。

## ページツリー

- トップページは`kpw-docs/pages/index/index.md`で、URLは`/`に固定されます。
- 通常ページはGitHub上では`pages/<slug>/`へフラットに置き、`navigation.yml`のツリーから公開URLを組み立てます。
- URLは末尾スラッシュなしです。古い階層や過去slugは現在の正規URLへリダイレクトされます。
- エディターでは複数ページとツリー変更をブラウザに保持し、GitHub Appを使った1つのGit commitへまとめて保存します。
- 子を持つページは削除できません。先にページエクスプローラーで子を移動します。

## Discordログインとページ権限

既存のDiscord ApplicationへBotを追加し、次を設定します。

- OAuth2 Redirect URL: `https://<公開ドメイン>/api/auth/callback`
- OAuth2 scope: `identify`（アプリ側がログイン時に指定）
- Botを編集者が所属するDiscordサーバーへインストール
- Developer PortalのBot設定で`Server Members Intent`を有効化
- `DISCORD_ADMIN_ROLE_ID`に指定したロールは全ページの編集・構造変更・権限設定が可能

ページ権限はDiscordのロールまたは個人へ付与します。編集権限と子ページ作成権限は別々です。子ページ作成は次のどちらかを選びます。

- `inherit`: 作成したページも親の権限をライブ継承する。作成者はそのページを編集できるが、権限設定はできない。
- `custom`: 作成者がそのページ以下を管理し、権限を自由に設定できる。adminは常に管理可能。

未設定の既存ページはadminのみ編集できます。ロールはAPI呼び出しごとにDiscordから再確認するため、Discord側でロールを外すと権限も失われます。

## GitHub App（原稿保存用）

GitHub Appを作成し、次を設定します。

- Repository permissions: Metadata read、Contents read and write
- Installation: `KamePowerWorld/kpw-docs`だけを選択
- App IDを`GITHUB_APP_ID`へ設定
- ダウンロードしたPrivate Key（PEM全文）を`GITHUB_APP_PRIVATE_KEY` Secretへ設定
- Installation IDは`GITHUB_INSTALLATION_ID`へ任意設定。省略時はリポジトリから自動取得

GitHubユーザーのOAuth認証やPersonal Access Tokenは使用しません。

## Cloudflare

このリポジトリの`wrangler.jsonc`には本番のKV `SESSIONS`とD1 `kpw-web-auth`が設定済みです。

1. CloudflareのWorker設定で通常の環境変数`DISCORD_CLIENT_ID`、`DISCORD_GUILD_ID`、`DISCORD_ADMIN_ROLE_ID`、`GITHUB_APP_ID`を設定する。
2. `npx wrangler secret put DISCORD_CLIENT_SECRET`を実行する。
3. `npx wrangler secret put DISCORD_BOT_TOKEN`を実行する。
4. `npx wrangler secret put GITHUB_APP_PRIVATE_KEY`を実行し、PEM全文を登録する。
5. `npx wrangler d1 migrations apply kpw-web-auth --remote`で未適用のD1 migrationを反映する。
6. GitHub Organization Secretに`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`を登録する。
7. `npm run deploy`で配備する。

Cloudflare Dashboardで環境変数を管理するため、デプロイには`--keep-vars`を付けています。ローカルでは`.dev.vars.example`を`.dev.vars`へコピーして値を設定します。秘密値をリポジトリへcommitしないでください。

## セキュリティ

- DiscordセッションはHttpOnly・Secure・SameSite Cookieで管理し、保存と権限変更はOrigin、CSRF token、現在のDiscord所属・ロールを検証します。
- GitHub AppのInstallation tokenはサーバー内で短時間だけ使用し、ブラウザへ渡しません。
- Markdownと画像はデータとして扱い、HTML、SVG、危険なパス、過大ファイルを拒否します。
- GitHub保存は開始時commit SHAを照合し、競合時に`master`を上書きしません。
- 権限変更はD1のrevisionで競合を検出し、操作履歴を`audit_events`へ記録します。
