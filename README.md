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

**主なオプション:** `--target-pr` / `--repository`（別名 `--repo`）/ `--lookback-days`（既定 30）/ `--fetch-budget`（既定 100、1 回の実行で新規に取得するマージ済み PR の上限）/ `--fetch-limit`（既定 1000）/ `--log-path` / `--snapshot-path` / `--cache-path`（マージ済みサンプルのキャッシュ。省略時はキャッシュを使わず、取得予算の件数だけで統計を計算）/ `--as-json`（スナップショットを標準出力へ）/ `--no-log`（履歴 CSV **と** スナップショットの保存を行わない）

**マージ済みサンプルのキャッシュ:** マージ済み PR の履歴（起票・コミット・条件成立・マージの時刻）は後から変わらないため、`--cache-path`（定期実行では `data/merged-samples.jsonl`）に計測結果を保存して再利用します。統計は、期間内（`--lookback-days`、既定 30 日）にマージされたキャッシュ全件で計算し、1 回の実行で新たに取得するのは、新しくマージされた PR と、未取得の古い PR を新しい順に `--fetch-budget` 件までです。そのため、API の消費量（サンプル 1 件あたりコア API 約 3 件）は 1 回あたり一定のまま、数日かけて統計の件数が増えていきます。条件不成立で除外した PR も記録し、再取得しません。キャッシュが壊れているときは、統計を歪めないよう中断します。実行の最後に、レート制限の残量（`GITHUB_TOKEN` は 1 時間あたり 1,000 件・リポジトリ単位）を `[RateLimit]` として出力します。

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
  - ダッシュボードには、過去のマージ実績との比較（中央値・75%点・最大、基準 PR の位置づけ）、追い越しの比較、直前のライバル PR、比較に使ったサンプル一覧、キュー境界（健康的大底・真の大底・特急レーン）も表示します。
  - ダッシュボードの最上部には、マージ時期を 3 つの仮説で予想して比較するパネルを置きます。① 順位消化（実質待ち件数が直近の速度で減り続ける）、② 更新順（更新の古い順に処理される。遭難の底の先頭が基準 PR の更新時刻に届いた時点。定常待ち時間と実測の進みの 2 モデル）、③ 作成順（直近のマージ実績の通算所要日数が当てはまる）の予想日と進捗を並べ、見出しには主な予想日の範囲を出します（どの仮説が実態に近いかは未検証のため、単一の日付は出しません）。
  - 予想日は観測のたびに `data/forecast-history.jsonl`（Dropbox 同期対象）へ記録します（`src/cli/record-forecast.ts`）。基準 PR がマージされると、実際のマージ日を 1 回だけ記録し、ダッシュボードの「予想の答え合わせ」に仮説・モデルごとの予想誤差（予想日 − 実際のマージ日）を表示します。
  - ダッシュボードの「待ち行列からの離脱の内訳」は、実質待ち（更新順の順位）の減少を、マージ・未マージのクローズ・健康条件の変化など・更新による順位の入れ替わりに分解します。観測のたびに、基準 PR の起票以降にマージ・クローズされた、起票が基準 PR より前で必須ラベルが付いた PR の累積件数（検索の集計。`MergedOlder` / `ClosedOlder` 列）を履歴 CSV に残し、その差と、実質待ち・累積待ちの減少から求めます。仮説①（順位消化）の速度が、実際のマージをどれだけ反映しているかの目安です。「健康条件の変化など」と「更新による順位の入れ替わり」は差し引きによる推定です。
- **Dropbox App Folder による生データ永続化**:
  - 収集された CSV / JSONL / JSON は、`scripts/sync-dropbox.ts` を通じて Dropbox の専用 App Folder（`/data/`）へ自動同期・蓄積されます。
  - Git リポジトリ（`main` ブランチ）への直接 push を全廃し、厳格なブランチ保護ルールを維持します。
  - 観測データの正は Dropbox（`/data/`）で、リポジトリでは追跡しません（`.gitignore` 対象）。`data/` はローカルの作業領域で、定期実行はワークフロー開始時に Dropbox から最新の履歴を取得して `data/` に展開します。ローカルで実行する場合も、先に `bun run scripts/sync-dropbox.ts --direction download` で取得してください（資格情報が無い環境では `--allow-skip` を付けるとスキップでき、その場合は空の状態から計測が始まります）。

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
