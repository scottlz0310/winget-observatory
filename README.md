# winget-observatory

[![CI](https://github.com/scottlz0310/winget-observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/scottlz0310/winget-observatory/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/scottlz0310/winget-observatory/graph/badge.svg)](https://codecov.io/gh/scottlz0310/winget-observatory)
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

**主なオプション:** `--target-pr` / `--repository`（別名 `--repo`）/ `--lookback-days`（既定 30）/ `--sample-size`（既定 30）/ `--fetch-limit`（既定 1000）/ `--log-path` / `--snapshot-path` / `--as-json`（スナップショットを標準出力へ）/ `--no-log`（履歴 CSV **と** スナップショットの保存を行わない）

基準 PR が観測対象外（クローズ済み・Draft・必須ラベル不足・阻害ラベルあり）の場合は、履歴もスナップショットも記録せずに終了します（GitHub Actions 上では warning を出力）。

**計測項目:**

- **消化前線**: 健康的な未マージ PR の中で最も古い PR 番号と起票日
- **実質待ち件数**: 更新順で対象 PR より前に並ぶ健康的な未マージ PR の件数（指摘なく順番待ちを続ける PR の待ち順位。更新があった PR は順位が後ろへ動く）
- **累積待ち件数**: 作成順で対象 PR より前に起票された、条件を満たす未マージ PR の総数（過去の滞留分を含む全期間。検索 API のヒット件数）
- **通算待機日数 (Total)** / **レビュー待ち時間 (Turn)** / **条件成立後待機 (Ready)**
- **マージ実績との比較**: 過去サンプルの中央値（Median）・75%点（P75）・最大との比較。基準 PR の待機が実績の中でどこに位置するか（中央値までの残り、サンプルの何 % より待っているか）も出力
- **追い越しの比較**: 採用サンプルのうち、基準 PR より後に作成・成立してマージされた件数と、古い PR から順に消化されているかの判定
- **直前のライバル PR**: 作成順で基準 PR の直前に並ぶ健康的な未マージ PR（最大 5 件、起票・更新日時付き）
- **比較に使ったサンプル**: 採用数・除外数と、サンプル一覧（コミット数・各待機日数・マージ日時）

### 2. `src/cli/explore-depths.ts`（キュー境界探索）

現在のキューの各「底（境界）」を立体的にスキャンします。

```bash
# キュー境界を探索
bun run explore:depths

# JSON 出力でスナップショット保存
bun run explore:depths --output-path "data/latest-depths.json"
```

**主なオプション:** `--target-pr` / `--repository` / `--output-path` / `--history-path` / `--as-json` / `--no-history`（JSONL 追記なし）/ `--no-target-pr`（基準 PR なしの全体観測）

基準 PR の取得に失敗した場合は、基準 PR 無しのデータを履歴へ残さないよう中断します。基準 PR なしで実行したいときは `--no-target-pr` を明示してください。

**スキャン境界:**

1. **健康的な大底 (Healthy Bottom)**: CI 通過・エラーなしの健康体で、現在最も古いオープン PR（FIFO の正当な先頭）
2. **真の大底 (Absolute Bottom)**: 状態やエラーを問わず、未クローズの New-Package で最も古い PR
3. **遭難の底 (Stale Bottom)**: 健康体の中で更新日時（updated）が最も古い PR。指摘が一度も付かず、すぐ健康になって順番を待つだけの PR（基準 PR と同じ種類）で、このキューの実質的な先頭。上位 10 件を記録し、推移から進み具合を見る
4. **特急レーン・追い越し (Express Lane)**: 基準 PR 起票日以降に起票され、すでにマージされた PR

---

## データ蓄積と自動化（GitHub Actions / Dropbox / GitHub Pages）

GitHub Actions ワークフロー（[.github/workflows/observe.yml](.github/workflows/observe.yml)）により、4時間おきに自動でメトリクスを収集・公開します。

- **GitHub Pages によるダッシュボード公開**:
  - `scripts/build-pages.ts` により生成された HTML ダッシュボードが GitHub Pages へ直接デプロイされます。
  - `actions/deploy-pages` を使用するため、Git コミットや `gh-pages` ブランチの作成を行わずクリーンに公開されます。
  - 最新のダッシュボードと推移データは <https://scottlz0310.github.io/winget-observatory/> で公開されます（人間が読む場所は Pages に一本化しており、リポジトリ内に生成物のドキュメントは置きません）。
  - ダッシュボードの「マージ時期の予想」は、遭難の底（更新が最も古い健康な PR）の先頭の進みから基準 PR のマージ時期を予想する参考値です。「更新の古い順に処理される」という仮説に基づき、先頭の遅れが一定とする定常待ち時間モデルと、履歴から先頭の進みを実測する観測速度モデルを並べて表示します（進みが観測できない間は後者は算出不能と表示）。
- **Dropbox App Folder による生データ永続化**:
  - 収集された CSV / JSONL / JSON は、`scripts/sync-dropbox.ts` を通じて Dropbox の専用 App Folder（`/data/`）へ自動同期・蓄積されます。
  - Git リポジトリ（`main` ブランチ）への直接 push を全廃し、厳格なブランチ保護ルールを維持します。
  - リポジトリ内の `data/` は旧運用（main への自動コミット）時点のスナップショットで、現在は更新されません。定期実行はワークフロー開始時に Dropbox から最新の履歴を取得して `data/` を上書きします（ローカル実行時の初期データとして残しています）。

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

- [x] **データ可視化 (Visualization)**: 蓄積された CSV/JSON を用いた GitHub Pages ダッシュボード自動生成（ETA・消化速度・差分・パーセンタイル統計）
- [ ] **複数 PR 同時観測**: 複数の PR を一括監視・比較するモードの追加
- [ ] **トリアージ速度推移の分析**: 曜日別・時間帯別のレビュー消化ペース推定

---

## 開発・コントリビューション

### 前提ツール

- [Bun](https://bun.sh/)（バージョンは `.bun-version` に従う。スクリプト実行・テスト・Biome / Lefthook 実行用）
- [GitHub CLI (gh)](https://cli.github.com/)（必要に応じて PR / Issue 操作用）

```bash
# 依存ツールのセットアップ
bun install

# 型チェック
bun run typecheck

# Lint / Format の確認
bun run check
bun run format

# テスト実行（カバレッジ計測含む）
bun run test
bun run test:coverage
```

---

## ライセンス

[MIT License](LICENSE) &copy; 2026 scottlz0310
