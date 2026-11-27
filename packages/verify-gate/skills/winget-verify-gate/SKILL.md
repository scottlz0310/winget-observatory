---
name: winget-verify-gate
description: Pre-submission verification gate for microsoft/winget-pkgs initial package PRs. Run verify-gate CLI or MCP tools to catch manifest, URL, SHA-256, PE runtime DLL, and Policy-Test blockers before opening a PR.
license: MIT
metadata:
  author: scottlz0310
  version: "0.2.0"
  guide: references/submission-guide.md
  template: templates/pr-template.md
---

# WinGet Verify Gate (`winget-verify-gate`)

`microsoft/winget-pkgs` へ初回パッケージ提出 PR を作成・更新する前に、機械検証できるブロッカーをすべて潰すための提出前関門スキルです。

## いつ使うか

- 新規パッケージ（`New package:`）または更新マニフェストを `microsoft/winget-pkgs` へ提出する直前
- レビュー指摘を受けてマニフェストや配布バイナリを修正した直後

## 実行手順（MCP ツール優先・CLI フォールバック）

1. **マニフェスト診断を実行する**:
   - MCP 利用時: `verify_manifest`（`manifestDir`、任意で `binaryPath`・`offline`）を実行する。
   - CLI フォールバック時: `winget-verify-gate check <manifest-dir> [--binary <path>] [--offline] [--json]`（または `bunx @scottlz0310/winget-verify-gate check ...`）
2. **バイナリ単体検査が必要な場合**:
   - MCP 利用時: `verify_binary`（`binaryPath`、任意で `expectedArchitecture`）を実行する。
   - CLI フォールバック時: `winget-verify-gate binary <path> [--arch x64|arm64|x86] [--json]`
3. **検出された `fail` / `warn` を解消する**:
   - 各 finding にはチェック ID（`CMN-*` / `PKG-*` / `APP-*` / `NG-*`）と修正手順が含まれる。
   - 詳細な背景・実 PR 事例が必要な場合のみ `references/submission-guide.md` を参照する。
4. **クリーン Windows Sandbox 検証と先回り PR 本文を作成する**:
   - MCP 利用時: `prepare_sandbox`（`manifestDir`, `outDir`）で `.wsb`・Sandbox 内自動検証スクリプト（`LocalManifestFiles` 有効化・`winget install -m`・ARP 4 ハイブダンプ・CLI 引数なし/`--version`/`--help` 実測・`winget uninstall` 残骸検査）を生成し、実行後に `evaluate_sandbox`（または `verify_manifest` の `sandboxResultPath`）でマニフェストと突き合わせる。
   - CLI フォールバック時: `winget-verify-gate sandbox prepare <manifest-dir> --out <dir>` → Sandbox 実行 → `winget-verify-gate sandbox eval <manifest-dir> --result <sandbox-result.json>`（`Tools/SandboxTest.ps1` 併用手順は `references/submission-guide.md` §7.1 参照）。
   - PR 本文の末尾に `templates/pr-template.md` の Reviewer Notes を記入して提出し、提出直後に `@microsoft-github-policy-service agree` で CLA 同意を完了する。

## 同梱リソース

- `references/submission-guide.md`: 配布形式 × アプリ種別マトリクスチェックリスト＆実 PR 事例ガイド
- `templates/pr-template.md`: `microsoft/winget-pkgs` 貼付用 先回り PR 本文テンプレート
