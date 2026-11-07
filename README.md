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

## 主なツール (TypeScript / Bun)

### 1. `src/cli/progress.ts`（進捗メトリクス計測）

指定した PR またはキュー全体の待機時間、消化前線、待ち件数、過去 30 日間のマージ実績サンプル（中央値・P75）を算出・記録します。

```bash
# デフォルト（環境変数または既定PR）で実行
bun run progress

# PR番号を指定して実行
bun run progress --target-pr 464302

# 出力先を指定
bun run progress --target-pr 464302 --log-path "data/progress-history.csv" --snapshot-path "data/latest-progress.json"
```

**計測項目:**

- **消化前線**: 健康的な未マージ PR の中で最も古い PR 番号と起票日
- **実質待ち件数**: 前線〜対象 PR 間で現在生きている健康的な PR 件数
- **累積待ち件数**: 前線〜対象 PR 間の総 PR 番号差
- **通算待機日数 (Total)** / **レビュー待ち時間 (Turn)** / **条件成立後待機 (Ready)**
- **マージ実績との比較**: 過去サンプルの中央値（Median）および 75%点（P75）との比較

### 2. `src/cli/explore-depths.ts`（キュー境界探索）

現在のキューの各「底（境界）」を立体的にスキャンします。

```bash
# キュー境界を探索
bun run explore:depths

# JSON 出力でスナップショット保存
bun run explore:depths --output-path "data/latest-depths.json"
```

**スキャン境界:**

1. **健康的な大底 (Healthy Bottom)**: CI 通過・エラーなしの健康体で、現在最も古いオープン PR（FIFO の正当な先頭）
2. **真の大底 (Absolute Bottom)**: 状態やエラーを問わず、未クローズの New-Package で最も古い PR
3. **遭難・放置の底 (Stale Bottom)**: 健康体の中で更新日時（updated）が最も古く、完全に止まっている PR
4. **特急レーン・追い越し (Express Lane)**: 基準 PR 起票日以降に起票され、すでにマージされた PR

### 3. `src/cli/generate-summary.ts`（まとめダッシュボード生成）

蓄積された進捗ログ（CSV）および最新スナップショット（JSON）から、人間が見て一目で状況を把握できる Markdown ドキュメント（[`SUMMARY.md`](SUMMARY.md)）を自動生成します。

```bash
bun run summary --output-path "SUMMARY.md"
```

---

## データ蓄積と自動化（GitHub Actions / Dropbox / GitHub Pages）

GitHub Actions ワークフロー（[.github/workflows/observe.yml](.github/workflows/observe.yml)）により、4時間おきに自動でメトリクスを収集・公開します。

- **GitHub Pages によるダッシュボード公開**:
  - `scripts/build-pages.ts` により生成された HTML ダッシュボードが GitHub Pages へ直接デプロイされます。
  - `actions/deploy-pages` を使用するため、Git コミットや `gh-pages` ブランチの作成を行わずクリーンに公開されます。
- **Dropbox App Folder による生データ永続化**:
  - 収集された CSV / JSONL / JSON は、`scripts/sync-dropbox.ts` を通じて Dropbox の専用 App Folder（`/winget-observatory/`）へ自動同期・蓄積されます。
  - Git リポジトリ（`main` ブランチ）への直接 push を全廃し、厳格なブランチ保護ルールを維持します。

### 自動化・連携スクリプト

- **`scripts/build-pages.ts`**: 観測データからレスポンシブな Web ダッシュボード（`site/index.html`）を生成
- **`scripts/sync-dropbox.ts`**: `data/` 配下のメトリクスと Dropbox App Folder の安全なアップロード／ダウンロード同期

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
