# kpw-web

かめぱわぁ〜るどガイドのAstroサイト、WYSIWYGエディター、GitHub連携APIです。原稿は [KamePowerWorld/kpw-docs](https://github.com/KamePowerWorld/kpw-docs) で管理します。

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
- エディターでは複数ページとツリー変更をブラウザに保持し、1つのGit commitまたはPull Requestへまとめて保存します。
- 子を持つページは削除できません。先にページエクスプローラーで子を移動します。

## GitHub App

GitHub Appを作成し、次を設定します。

- Callback URL: `https://<公開ドメイン>/api/auth/callback`
- Repository permissions: Metadata read、Contents read and write
- Installation: `KamePowerWorld/kpw-docs`
- 外部投稿者は最初に`kpw-docs`をforkし、そのforkへAppをインストールする

`GITHUB_CLIENT_ID`は`wrangler.jsonc`で管理し、Cloudflareへ`GITHUB_CLIENT_SECRET`だけをSecretとして登録します。ローカルでは`.dev.vars.example`を`.dev.vars`へコピーして値を設定します。

## Cloudflare

1. `wrangler kv namespace create kpw-web-SESSIONS`を実行する。
2. 返されたIDを`wrangler.jsonc`の`SESSIONS`へ設定する。ローカル開発ではWranglerのローカルKVを使用する。
3. `wrangler secret put GITHUB_CLIENT_SECRET`を登録する。
4. GitHub Organization Secretに`CLOUDFLARE_API_TOKEN`と`CLOUDFLARE_ACCOUNT_ID`を登録する。
5. `npm run deploy`で初回配備する。

## セキュリティ

- 外部Pull Requestでは`kpw-web/master`の信頼済みコードだけを実行します。
- 提案されたMarkdownと画像はデータとして読み込み、HTML、SVG、シンボリックリンク、危険なパス、過大ファイルを拒否します。
- GitHub保存は開始時commit SHAを照合し、競合時に`master`を上書きしません。
