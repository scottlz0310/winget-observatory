# winget-observatory

[![CI](https://github.com/scottlz0310/winget-observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/scottlz0310/winget-observatory/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

巨大 OSS [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) のレビュートリアージ・キュー境界・消化速度を定点観測（Observatory）し、メトリクスを自動蓄積・分析するためのツールキットです。

---

## 概要

`microsoft/winget-pkgs` は毎日膨大なパッケージ登録・更新 PR が寄せられる超巨大リポジトリです。CI 正常通過後のレビュートリアージは FIFO（先入れ先出し）を基本としていますが、以下の要因により見かけの待機日数と実際の消化順序には大きな乖離が生じます。

- **前線の停滞**: 過去の古い PR で要対応ラベルが付いたまま残存しているバックログ
- **キューの健全性境界**: CI 通過・エラーなしの「健康的な PR」と、保留中・調査中 PR の混在
- **特急レーン・追い越し**: 新規 PR が先にレビュー・マージされる現象

`winget-observatory` は、自分の PR やキュー全体の消化状況を定量的に観測・記録し、推移ログを自動蓄積します。

---

## 主なツール

### 1. `scripts/progress-winget.ps1`（進捗メトリクス計測）

指定した PR またはキュー全体の待機時間、消化前線、待ち件数、過去 30 日間のマージ実績サンプル（中央値・P90）を算出・記録します。

```powershell
# デフォルト（環境変数または既定PR）で実行
./scripts/progress-winget.ps1

# PR番号を指定して実行
./scripts/progress-winget.ps1 -PrNumber 464302

# 出力先を指定
./scripts/progress-winget.ps1 -PrNumber 464302 -LogPath "data/progress-history.csv" -SnapshotPath "data/latest-progress.json"
```

**計測項目:**

- **消化前線**: 健康的な未マージ PR の中で最も古い PR 番号と起票日
- **実質待ち件数**: 前線〜対象 PR 間で現在生きている健康的な PR 件数
- **累積待ち件数**: 前線〜対象 PR 間の総 PR 番号差
- **通算待機日数 (Total)** / **レビュー待ち時間 (Turn)** / **条件成立後待機 (Ready)**
- **マージ実績との比較**: 過去サンプルの中央値（Median）および 90%タイル（P90）との比較

### 2. `scripts/explore-winget-depths.ps1`（キュー境界探索）

現在のキューの各「底（境界）」を立体的にスキャンします。

```powershell
# キュー境界を探索
./scripts/explore-winget-depths.ps1

# JSON 出力でスナップショット保存
./scripts/explore-winget-depths.ps1 -OutputPath "data/latest-depths.json"
```

**スキャン境界:**

1. **健康的な大底 (Healthy Bottom)**: CI 通過・エラーなしの健康体で、現在最も古いオープン PR（FIFO の正当な先頭）
2. **真の大底 (Absolute Bottom)**: 状態やエラーを問わず、未クローズの New-Package で最も古い PR
3. **遭難・放置の底 (Stale Bottom)**: 健康体の中で更新日時（updated）が最も古く、完全に止まっている PR
4. **特急レーン・追い越し (Express Lane)**: 基準 PR 起票日以降に起票され、すでにマージされた PR

### 3. `scripts/generate-summary.ps1`（まとめダッシュボード生成）

蓄積された進捗ログ（CSV）および最新スナップショット（JSON）から、人間が見て一目で状況を把握できる Markdown ドキュメント（[`SUMMARY.md`](SUMMARY.md)）を自動生成します。

```powershell
./scripts/generate-summary.ps1 -OutputPath "SUMMARY.md"
```

---

## データ蓄積と GitHub Actions

GitHub Actions ワークフロー（[.github/workflows/observe.yml](.github/workflows/observe.yml)）により、4時間おきに自動でメトリクスを収集し、リポジトリにコミットします。

- **`SUMMARY.md`**: 最新のキュー状況・Mermaid フローチャート・統計比較・直近推移をまとめた人間向けダッシュボード
- **`data/progress-history.csv`**: 時系列の進捗推移ログ（前線PR、実質待ち、累積待ち、待機日数推移）
- **`data/depths-history.jsonl`**: キュー境界（各底のPRスキャン結果）の時系列追記ログ（1行1JSON）
- **`data/latest-progress.json`**: 最新実行時の進捗構造化スナップショット
- **`data/latest-depths.json`**: 最新実行時の境界探索スナップショット

---

## 環境変数による柔軟な設定

スクリプトはパラメータ引数のほか、環境変数による既定値の上書きに対応しています。

| 環境変数                     | 説明                        | デフォルト値                |
| ---------------------------- | --------------------------- | --------------------------- |
| `WINGET_TARGET_PR`           | 観測対象の PR 番号          | `464302`                    |
| `WINGET_REPOSITORY`          | 対象リポジトリ              | `microsoft/winget-pkgs`     |
| `WINGET_LOG_PATH`            | 履歴 CSV 保存先パス         | `data/progress-history.csv` |
| `WINGET_DEPTHS_HISTORY_PATH` | キュー境界 JSONL 保存先パス | `data/depths-history.jsonl` |
| `WINGET_SNAPSHOT_PATH`       | 最新進捗 JSON 保存先パス    | `data/latest-progress.json` |
| `WINGET_DEPTHS_OUTPUT_PATH`  | 最新境界 JSON 保存先パス    | `data/latest-depths.json`   |

---

## 今後の展望 (Roadmap)

- [ ] **データ可視化 (Visualization)**: 蓄積された CSV/JSON を用いたグラフ化（GitHub Pages / SVG レポート生成）
- [ ] **複数 PR 同時観測**: 複数の PR を一括監視・比較するモードの追加
- [ ] **トリアージ速度推移の分析**: 曜日別・時間帯別のレビュー消化ペース推定

---

## 開発・コントリビューション

### 前提ツール

- [PowerShell 7+](https://github.com/PowerShell/PowerShell)
- [GitHub CLI (gh)](https://cli.github.com/)
- [Bun](https://bun.sh/)（Biome / Lefthook 実行用）

```powershell
# 依存ツールのセットアップ
bun install

# Lint / Format の確認
bun run check
bun run format
```

---

## ライセンス

[MIT License](LICENSE) &copy; 2026 scottlz0310
