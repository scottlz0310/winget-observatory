# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- キュー境界探索の時系列 JSONL 蓄積機能（`data/depths-history.jsonl`）を追加
- 観測データを人が見て一目で把握できるまとめドキュメント自動生成スクリプト（`scripts/generate-summary.ps1` -> `SUMMARY.md`）を追加

### Changed

- 観測スクリプト（`progress-winget.ps1`, `explore-winget-depths.ps1`）を `scripts/` ディレクトリへ集約
- スクリプト配置変更に伴うデータディレクトリ（`data/`）の自動解決ロジックを強化
- GitHub Actions 観測ワークフローで `SUMMARY.md` および `depths-history.jsonl` の自動更新・コミットに対応

## [0.1.0] - 2026-11-06

### Added

- `microsoft/winget-pkgs` のレビュートリアージ・キュー境界・消化速度を定点観測する PowerShell スクリプト群を追加
  - `progress-winget.ps1`: PR 待機時間、消化前線、待ち件数、過去 30 日間マージ実績サンプル（中央値・P90）の集計・推移記録
  - `explore-winget-depths.ps1`: 健康的な大底、真の大底、遭難・放置の底、特急レーンのキュー境界探索
- スクリプトのパラメータ柔軟化と環境変数対応（`WINGET_TARGET_PR`, `WINGET_REPOSITORY`, `WINGET_LOG_PATH`, `WINGET_SNAPSHOT_PATH`）
- 最新観測スナップショットの JSON 保存対応（`data/latest-progress.json`, `data/latest-depths.json`）
- 過去の推移履歴（`data/progress-history.csv`）の初期配置
- GitHub Actions ワークフローの追加
  - 定期実行ワークフロー（`.github/workflows/observe.yml`）: cron 4時間おきのメトリクス自動蓄積とコミット
  - CI ワークフロー（`.github/workflows/ci.yml`）: Biome による lint/format 検査および PSScriptAnalyzer / pwsh による構文検査
- プロジェクト基盤の整備
  - MIT ライセンス（`LICENSE`）
  - Biome 2.x および Lefthook の pre-commit 構成
  - Renovate 設定（`renovate.json`）
  - リポジトリドキュメント（`README.md`）
