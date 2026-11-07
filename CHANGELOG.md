# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `scripts/lib/dropbox.ts`, `scripts/lib/redact.ts`: 外部依存なしで動作する Dropbox App Folder 連携クライアントおよび機密情報サニタイズ処理
- `scripts/sync-dropbox.ts`: `data/` 配下の観測メトリクス（CSV, JSONL, JSON）と Dropbox App Folder の自動同期スクリプト
- `scripts/build-pages.ts`: 観測データからレスポンシブな Web ダッシュボード（`site/index.html`）を生成する HTML ビルドスクリプト
- ユニットテスト群（`test/dropbox.test.ts`, `test/redact.test.ts`, `test/build-pages.test.ts`, `test/sync-dropbox.test.ts`）

### Fixed

- `scripts/build-pages.ts`: キュー境界探索の遭難・放置の底の参照キーを `StrandedCandidates` から出力契約である `StaleBottom` へ修正し、ダッシュボード HTML への表示欠落を解消
- `.github/workflows/observe.yml`: 定期観測時の Dropbox 同期ステップから `--allow-skip` を撤廃し、資格情報未設定時に永続化をスキップして Pages 公開へ進まないよう非ゼロ終了を保証

### Changed

- `scripts/lib/dropbox.ts`: Dropbox アプリフォルダー内の二重階層を解消するため、保存先プレフィックス `DROPBOX_ROOT` を `/winget-observatory/` から `/data/` へ変更。移行互換用として旧プレフィックス `LEGACY_DROPBOX_ROOT`（`/winget-observatory/`）の読み取りを許容
- `scripts/sync-dropbox.ts`: 新パス `/data/` にファイルが存在しない場合に旧パス `/winget-observatory/` から履歴データを自動取得・引き継ぐフォールバック機能（`downloadMetricsFiles`）を追加し、手動移行作業不要のシームレスな移行を保証
- `.github/workflows/observe.yml`: `main` 直 push を全廃し、Dropbox への生データ保存および `actions/deploy-pages` による GitHub Pages 直接デプロイへ刷新（ブランチ保護ルールを完全遵守）
- `.github/workflows/ci.yml`: `bun test` による TypeScript ユニットテストステップを追加
- `package.json`: `test`, `build:pages`, `sync:dropbox` スクリプトを追加
- `README.md`: Dropbox 連携および GitHub Pages による自動化運用に関するドキュメントを更新

## [0.1.0] - 2026-11-06

### Changed

- `package.json` の初期バージョンを `0.0.0` に設定（`release-automate` による `0.1.0` リリース準備 PR 作成時のバージョンバンプ契約に対応）

### Fixed

- `scripts/explore-winget-depths.ps1`, `scripts/progress-winget.ps1`, `scripts/generate-summary.ps1` において、`ToLocalTime()` 依存による実行環境（GitHub Actions 等の UTC ランナー）での JST 日時ズレを解消し、`ToOffset([TimeSpan]::FromHours(9))` による明示的な JST 変換に統一
- 観測データ保存（CSV, JSON, JSONL）失敗時に例外を握りつぶさずコンテキスト付きで再 throw してプロセスを非ゼロ終了するよう修正
- `CHANGELOG.md` 末尾に `[Unreleased]` 比較リンク定義を追加し、`release-automate` による版確定処理の正規表現契約を満たすよう対応

### Added

- `microsoft/winget-pkgs` のレビュートリアージ・キュー境界・消化速度を定点観測する PowerShell スクリプト群を追加
  - `scripts/progress-winget.ps1`: PR 待機時間、消化前線、待ち件数、過去 30 日間マージ実績サンプル（中央値・P90）の集計・推移記録
  - `scripts/explore-winget-depths.ps1`: 健康的な大底、真の大底、遭難・放置の底、特急レーンのキュー境界探索
  - `scripts/generate-summary.ps1`: 観測データを人が見て一目で把握できるまとめダッシュボード（`SUMMARY.md`）の自動生成
- スクリプトのパラメータ柔軟化と環境変数対応（`WINGET_TARGET_PR`, `WINGET_REPOSITORY`, `WINGET_LOG_PATH`, `WINGET_SNAPSHOT_PATH`, `WINGET_DEPTHS_HISTORY_PATH`）
- キュー境界探索の時系列 JSONL 蓄積（`data/depths-history.jsonl`）および最新スナップショット（`data/latest-progress.json`, `data/latest-depths.json`）の保存機能
- 過去の推移履歴（`data/progress-history.csv`）の初期配置
- GitHub Actions ワークフローの追加
  - 定期観測ワークフロー（`.github/workflows/observe.yml`）: cron（4時間おき）による自動計測、JSONL/CSV 追記および `SUMMARY.md` の自動コミット・push
  - CI ワークフロー（`.github/workflows/ci.yml`）: Biome による lint/format 検査および PSScriptAnalyzer / pwsh による構文検査
  - リリース自動化ワークフロー（`.github/workflows/prepare-release.yml`, `.github/workflows/release.yml`）: release-automate によるリリース PR 作成と GitHub Release 自動公開
- プロジェクト基盤の整備
  - MIT ライセンス（`LICENSE`）
  - Biome 2.x および Lefthook の pre-commit 構成
  - Renovate 設定（`renovate.json`）
  - リポジトリドキュメント（`README.md`）

[Unreleased]: https://github.com/scottlz0310/winget-observatory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/scottlz0310/winget-observatory/releases/tag/v0.1.0
