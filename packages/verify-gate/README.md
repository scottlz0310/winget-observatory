# @scottlz0310/winget-verify-gate

`microsoft/winget-pkgs` への初回パッケージ提出 PR を作成する前に、マニフェスト・配布 URL・SHA-256・Windows PE バイナリ（CRT DLL 依存／署名）・Windows Sandbox 検証結果（ARP 4 ハイブ突き合わせ／CLI 終了コード）を機械検証するための **STDIO CLI ＋ MCP サーバー（`io.modelcontextprotocol/skills` 対応）** です。

90 日窓 3,603 件の `microsoft/winget-pkgs` 実 PR コーパス分析から抽出した差し戻しブロッカーを、PR 提出前に一括検出します。

## インストール / 実行方法

### 1. `bunx --bun` / `npx` で即時実行（推奨・Node.js 20+ または Bun）

```bash
# Bun（Node.js 未導入環境でも動作するよう --bun をパッケージ名より前に指定）
bunx --bun @scottlz0310/winget-verify-gate check ./manifests/e/Example/MyApp/1.0.0

# Node.js
npx -y @scottlz0310/winget-verify-gate check ./manifests/e/Example/MyApp/1.0.0
```

> **補足**: 配布バンドルの shebang は Node.js / Bun 両対応のため `#!/usr/bin/env node` を採用しています。Node.js を入れていない Bun 単独環境では、`bunx` に `--bun` をパッケージ名より前に付けて実行してください。

### 2. グローバルインストール

```bash
bun add -g @scottlz0310/winget-verify-gate
# または npm install -g @scottlz0310/winget-verify-gate

winget-verify-gate --version
```

### 3. 単体バイナリ（Node.js / Bun 不要）

[GitHub Releases](https://github.com/scottlz0310/winget-observatory/releases) から各環境向け単体バイナリ（`winget-verify-gate-windows-x64.exe` / `windows-arm64.exe` / `linux-x64` / `darwin-arm64`）と `SHA256SUMS.txt` をダウンロードして直接実行できます。

## MCP サーバー登録（STDIO + `io.modelcontextprotocol/skills`）

MCP クライアント（Antigravity / Claude Code / Codex / Cursor 等）の MCP 設定へ以下を追加します。

### `bunx --bun` を使う場合

```json
{
  "mcpServers": {
    "winget-verify-gate": {
      "command": "bunx",
      "args": ["--bun", "@scottlz0310/winget-verify-gate", "mcp"]
    }
  }
}
```

### `npx`（Node.js）を使う場合

```json
{
  "mcpServers": {
    "winget-verify-gate": {
      "command": "npx",
      "args": ["-y", "@scottlz0310/winget-verify-gate", "mcp"]
    }
  }
}
```

### 単体バイナリを使う場合（Windows 例）

```json
{
  "mcpServers": {
    "winget-verify-gate": {
      "command": "C:\\Tools\\winget-verify-gate-windows-x64.exe",
      "args": ["mcp"]
    }
  }
}
```

### Skills over MCP / 非対応クライアント向けエクスポート

- `io.modelcontextprotocol/skills`（SEP-2640）対応クライアントでは、サーバーから `skill://winget-verify-gate/SKILL.md`・`references/submission-guide.md`・`templates/pr-template.md` を自動配信します。
- 非対応クライアント向けに、同梱スキル一式をローカルディレクトリへ書き出せます:

```bash
bunx --bun @scottlz0310/winget-verify-gate skill export --out ./.agent/skills
```

## 主な CLI コマンド

```bash
# マニフェスト静的検証 + URL 到達性（--verify-sha256 で実ダウンロード照合、--binary で PE 解析も同時実行）
winget-verify-gate check <manifest-dir> [--binary <path>] [--sandbox-result <path>] [--offline] [--verify-sha256] [--json]

# Windows PE バイナリ単体診断（アーキテクチャ / 未同梱 VCRUNTIME140.dll 等 / Authenticode 署名）
winget-verify-gate binary <pe-path> [--arch x64|x86|arm64] [--json]

# Windows Sandbox 検証テンプレート（.wsb + WinGet 自動導入 / 4ハイブ ARP ダンプ / CLI 実測スクリプト）生成
winget-verify-gate sandbox prepare <manifest-dir> --out <dir> [--verify-command "myapp status"]

# Sandbox 実行後に生成された sandbox-result.json をマニフェストと突き合わせ評価
winget-verify-gate sandbox eval <manifest-dir> --result <sandbox-result.json> [--json]

# 同梱スキルの一覧表示・エクスポート
winget-verify-gate skill list [--json]
winget-verify-gate skill export --out <dir> [--json]

# STDIO MCP サーバー起動
winget-verify-gate mcp
```

### 公開 MCP ツール

| ツール名           | 役割                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `verify_manifest`  | マニフェストディレクトリの静的・URL/SHA-256・任意 PE・任意 Sandbox 結果を総合診断 |
| `verify_binary`    | Windows PE バイナリのアーキテクチャ・未同梱 CRT DLL・Authenticode 署名を検査      |
| `prepare_sandbox`  | Windows Sandbox 検証ファイル一式（`.wsb` / PowerShell 5.1 スクリプト）を生成      |
| `evaluate_sandbox` | `sandbox-result.json` の ARP 差分・アンインストール残骸・CLI 実測結果を評価       |

## 関連ドキュメント

- [winget-observatory リポジトリ](https://github.com/scottlz0310/winget-observatory)
- [microsoft/winget-pkgs 初回提出実践ガイド](https://github.com/scottlz0310/winget-observatory/blob/main/docs/winget-pkgs-submission-guide.md)
- [先回り PR 本文テンプレート](https://github.com/scottlz0310/winget-observatory/blob/main/docs/templates/winget-pkgs-pr-template.md)

## ライセンス

MIT
