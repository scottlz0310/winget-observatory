# winget-observatory-trigger

Cloudflare Workers の Cron Trigger から `winget-observatory` の GitHub Actions ワークフロー（`observe.yml`）を定時起動するトリガー Worker。

GitHub Actions 標準の `schedule`（cron）における遅延や間引きを回避し、正確な定時実行を保証するために使用します。

## 概要

- **実行間隔**: 4時間ごと（`0 */4 * * *`、`wrangler.toml` で定義）
- **認証方式**: GitHub App の秘密鍵から Web Crypto API（RS256）で JWT を生成し、短期間有効な Installation Access Token（`actions: write`）を取得して `workflow_dispatch` を呼び出します（PAT は使用しません）。
- **多重実行防止**: ワークフロー（`observe.yml`）側の `concurrency`（`cancel-in-progress: false`）により多重実行を防止します。

## GitHub App の準備

既存の GitHub App（`scottlz0310-global-automerge`）を流用します。

1. **権限設定**:
   - GitHub App の設定画面で、**Actions** 権限に **Read and write** を追加します。
2. **リポジトリへのインストール**:
   - `scottlz0310/winget-observatory` リポジトリへ App をインストール（または追加）し、権限を承認します。

## デプロイ手順

Cloudflare CLI（Wrangler）を使用してデプロイします。

```sh
cd workers/observe-trigger
bunx wrangler deploy
```

## Secrets（環境変数）の設定

初回デプロイ時、または鍵ローテーション時にシークレットを設定します。

### 自動登録スクリプト（推奨）

リポジトリルートの同期スクリプトを使用すると、共有 GitHub App（`scottlz0310/renovate-config` の `GLOBAL_AUTOMERGE_CLIENT_ID`）から Client ID を自動取得し、秘密鍵（PKCS#1 または PKCS#8）を PKCS#8 に自動変換した上で、Wrangler 経由でメモリから直接一括登録できます（ディスクやコマンドラインに平文の鍵は残りません）。

```sh
# 秘密鍵ファイルを指定して一括登録
bun run sync:secrets <秘密鍵.pem>

# または Client ID を明示指定して登録
bun run sync:secrets --client-id <id> <秘密鍵.pem>
```

### 手動登録（Wrangler 直接実行）

手動で登録する場合は以下を実行します：

```sh
# GitHub App の Client ID（または App ID）
bunx wrangler secret put GITHUB_APP_CLIENT_ID --config workers/observe-trigger/wrangler.toml

# GitHub App の秘密鍵（PKCS#8 形式の PEM）
bunx wrangler secret put GITHUB_APP_PRIVATE_KEY --config workers/observe-trigger/wrangler.toml
```

> [!NOTE]
> 手動登録の場合、`GITHUB_APP_PRIVATE_KEY` は PKCS#8 形式（`-----BEGIN PRIVATE KEY-----`）である必要があります。
> GitHub からダウンロードした秘密鍵が PKCS#1 形式（`-----BEGIN RSA PRIVATE KEY-----`）の場合は、事前に以下で変換してください：
> ```sh
> openssl pkcs8 -topk8 -nocrypt -in private-key.pem -out private-key-pkcs8.pem
> ```

必要に応じて、Installation ID を固定したい場合は以下も設定可能です（未設定時はリポジトリ情報から自動取得されます）：

```sh
bunx wrangler secret put GITHUB_INSTALLATION_ID --config workers/observe-trigger/wrangler.toml
```

## 動作確認

Cloudflare ダッシュボードの Workers 管理画面から Cron Trigger の「Test / Trigger」を実行するか、ローカル環境で単体テストを実行します。

```sh
bun test workers/observe-trigger/test
```
