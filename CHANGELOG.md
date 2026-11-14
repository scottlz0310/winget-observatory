# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `src/models/depths.ts`, `src/cli/explore-depths.ts`, `scripts/build-pages.ts`, `test/cli/explore-depths.test.ts`, `test/build-pages.test.ts`: 「🌱 初回提出者の底」テーブルの経過日数カラムが `UpdatedAt` 基準（「更新からの経過」）になっていた不整合を修正し、起票日時順の定義・統合時系列チャートと一致する `CreatedAt` 基準（「起票からの経過」）で計算・表示するよう変更（Issue #79）。あわせて `StaleBottom`（優等生の底）で `AuthorAssociation === "NONE"` かつ生涯マージ歴が 1 件以上の隠れ常連にも「常連除外」バッジが付くよう `DepthsRow.AuthorMergedCount` を追加し、`fetchStaleBottom` と `fetchFirstTimerBottom` で生涯マージ数キャッシュを共有して GraphQL 照会重複を回避

## [0.2.0] - 2026-11-14

### Added

- `src/models/progress.ts`, `src/models/sample-cache.ts`: `ProgressSnapshot` に初回提出者コホートの最終コミット後所要日数（Turn Latency）を記録する `FirstTimerTurnMedianDays` および `FirstTimerTurnP75Days` を追加（Issue #64）。`CachedSampleEntry` に初回判定バージョン `FirstTimerVersion` および除外由来 `FirstTimerReason` を追加し、キャッシュのバージョン管理と由来追跡を可能に
- `src/domain/search-window.ts`, `test/domain/search-window.test.ts`: GitHub Search API の 1,000 件制限を回避するための日付窓（スライス）分割純粋関数 `buildDateWindowSlices` を追加（Issue #62）。探索期間（90日間）を指定幅（既定 14 日間）の隙間のない降順スライスに分割し、`merged:START..END` クエリフラグメントを生成することで、数千件規模のマージ済み PR を 1,000 件上限で打ち切られることなく安全に全件走査可能にする
- `scripts/sync-worker-secrets.ts`, `test/scripts/sync-worker-secrets.test.ts`, `package.json`, `workers/observe-trigger/README.md`: Cloudflare Workers（`workers/observe-trigger`）へ GitHub App の Client ID と秘密鍵を安全に一括登録する同期スクリプト `sync:secrets`（`scripts/sync-worker-secrets.ts`）を追加（Issue #60）。`scottlz0310/renovate-config` の `GLOBAL_AUTOMERGE_CLIENT_ID` から Client ID を自動解決（明示指定や環境変数もサポート）し、秘密鍵（PKCS#1 または PKCS#8）を Web Crypto 互換の PKCS#8 PEM へ自動変換した上で、`wrangler secret bulk` に標準入力経由で安全に流し込むことで、ディスクやコマンドラインに平文の秘密鍵を残さず安全な一発登録を実現。単体テスト（13件）および README の手順ドキュメントを配備
- `workers/observe-trigger/`: Cloudflare Workers の Cron Trigger から GitHub Actions ワークフロー（`observe.yml`）を定時起動するトリガー Worker（`winget-observatory-trigger`）を新設（Issue #58）。Web Crypto API（RS256）を用いた GitHub App の JWT 署名、短期間有効な Installation Access Token（`actions: write`）の動的取得（または固定 ID 参照）、`workflow_dispatch` 呼び出し、誤アクセス防止のための 404 レスポンス、および単体テスト・Wrangler 設定・README を配備
- `src/api/github.ts`, `test/api/github.test.ts`: GitHub GraphQL API クライアントへの指数バックオフ付き自動リトライ実装を追加（Issue #56）。一時的なサーバーエラー（HTTP 502/503/504/429）および fetch の一時的なネットワークエラー（タイムアウト・接続切断・成功応答の本文受信中のストリーム切断等）に対して、指数バックオフ＋ジッター（初回 2,000ms → 4,000ms → 8,000ms + ジッター）で最大 3 回（計 4 回）まで自動リトライするよう改修。HTTP 429 応答時の `Retry-After` ヘッダーを待機時間の下限として尊重し指定期限前の再送を防止。401/403 や GraphQL 構文エラー・JSON パースエラー等は即座にエラーとし、リトライ発生時には標準エラー出力へ警告ログ（ステータスコード・試行回数・待機時間）を出力。単体テストにおいて 502 連続後の成功、上限回数超過での失敗、非リトライ対象ステータスでの即時失敗、Retry-After 下限待機、本文ストリーム切断からのリトライを網羅
- `src/models/progress.ts`, `src/domain/progress.ts`, `src/cli/progress.ts`, `scripts/build-pages.ts`, `test/domain/progress.test.ts`, `test/cli/progress.test.ts`, `test/build-pages.test.ts`, `README.md`: マージ実績サンプル窓の拡大および初回提出者コホート向けハイブリッド集計（Phase 5）を導入（Issue #54）。全体実績は直近のキュー消化速度の変化に敏感に追従する 30 日窓（`--lookback-days`、既定 30 日）を維持しつつ、サンプル数が希少な初回提出者コホートは 90 日窓（`--first-timer-lookback-days`、既定 90 日）に拡大して独立集計するハイブリッド構成を実装。マージ済み PR 探索クエリおよびキャッシュ（`merged-samples.jsonl`）の蓄積範囲を `max(lookbackDays, firstTimerLookbackDays)` 日前に拡大し、90 日窓内で複数回登場する author を常連として高精度に除外・判定。取得予算（`fetchBudget`）で保留（deferred）された未計測候補が除外数に誤混入しないよう、実際に条件不成立と判定された候補のみを 30 日窓で厳密に集計するよう修正。`ProgressSnapshot` に `FirstTimerLookbackDays` フィールドを追加し、ダッシュボード（`build-pages.ts`）の「🎯 初回提出者（純粋FIFO）サマリー」カードおよび「🌱 初回提出者コホート実績」カードに集計期間（例:「過去 90 日間・採用 N 件」）を明記
- `src/api/github.ts`, `src/cli/progress.ts`, `scripts/rest-client.ts`, `scripts/compare-rest-graphql.ts`, `test/architecture.test.ts`, `README.md`: GitHub API の GraphQL 一本化に向けた Phase 4（REST 経路の完全削除・GraphQL一本化の完了）を実施（Issue #48）。`src/api/github.ts` から REST 呼び出し（`/search/issues`・`/repos/...`・`/rate_limit`）を完全に撤廃し、`getRateLimit` を GraphQL `rateLimit` クエリのみに一本化。未使用になった REST メソッド（`searchIssuesRest`, `searchIssuesDetailedRest`, `getPullRequestDetailsRest`, `getIssueTimelineRest`）をプロダクションコード（`src/`）から削除し、比較検証用として独立した `scripts/rest-client.ts` へ分離。`src/cli/progress.ts` の `logRateLimit` を GraphQL レート制限枠の表示に一本化。`test/architecture.test.ts` に「`src/` 配下全体で GitHub REST API エンドポイントを直接参照しないこと」を静的解析で保証するアーキテクチャ境界テストを追加。`README.md` に GraphQL 一本化に伴う GitHub API アクセストークン（`GITHUB_TOKEN` / `GH_TOKEN`）の必須要件および未設定時の 401 エラー挙動を明記
- `src/api/github.ts`, `src/cli/progress.ts`, `scripts/compare-rest-graphql.ts`: GitHub API の GraphQL 一本化に向けた Phase 3（検索の GraphQL 移行）を実施（Issue #48）。`searchIssues`（`explore-depths.ts` 等）および `searchIssuesDetailed`（`progress.ts` 等）を GraphQL `search(type: ISSUE)` クエリ（`SEARCH_ISSUES_QUERY`）に移行。`buildGraphQLSearchQuery` により REST 互換のクエリ文字列およびソート修飾子（`sort:created-asc`, `sort:updated-desc` 等）を自動合成。`searchIssuesDetailed` ではカーソルページネーション対応（`cursor` パラメータおよび `page > 1` 時の内部走査フォールバック）を配備し、`progress.ts` のマージ済み PR 探索ループにおけるカーソル伝播を最適化。比較検証スクリプト `scripts/compare-rest-graphql.ts` のために独立した REST 検索メソッド `searchIssuesRest` および `searchIssuesDetailedRest` を新設し、GraphQL 化後も正当な REST vs GraphQL の検索件数・順序・フィールド整合性検証を保証
- `src/api/github.ts`, `scripts/compare-rest-graphql.ts`: GitHub API の GraphQL 一本化に向けた Phase 2（タイムラインの GraphQL 移行）を実施（Issue #48）。`getIssueTimeline` を GraphQL `repository.pullRequest.timelineItems` クエリに移行し、ドメイン判定に必要なイベント種別（`LABELED_EVENT`, `UNLABELED_EVENT`, `CONVERT_TO_DRAFT_EVENT`, `READY_FOR_REVIEW_EVENT`）のみを最大 10 ページ（最大 1,000 件）までカーソルページネーションで取得して `ProgressTimelineEvent[]` へ変換。実 API の `NOT_FOUND` errors 応答を安全に検知して 404 `GitHubApiError` へ変換しつつ、FORBIDDEN や INTERNAL 等の認可・障害エラーは元のエラーを保持。比較検証スクリプト `scripts/compare-rest-graphql.ts` のために独立した REST タイムライン取得メソッド `getIssueTimelineRest` を新設し、GraphQL 化後も正当な REST vs GraphQL のタイムライン整合性比較（`hasBlockingOrDraftHistory` および `simulateReadySince` の完全一致判定）を保証
- `src/api/github.ts`, `src/cli/progress.ts`, `scripts/compare-rest-graphql.ts`: GitHub API の GraphQL 一本化に向けた Phase 1（レート制限・単発 PR 取得の GraphQL 移行）を実施（Issue #48）。`getRateLimit` において GraphQL `rateLimit` クエリ（1pt消費）と REST `/rate_limit`（0pt消費）を並行取得し、GraphQL 枠および REST core / search 枠の真の実値を正確に分離して返却（REST search 枠の誤表示を防止）。`getPullRequest` および `getPullRequestDetails` を GraphQL `repository.pullRequest` クエリに移行し、PR 詳細・ラベル・コミット一覧（先頭 100 件）を 1 リクエストで一括取得。実 API の `NOT_FOUND` errors 応答を安全に検知して 404 `GitHubApiError` へ変換する経路（`GitHubGraphQLError` / `isPrNotFoundGraphQLError`）を配備。リポジトリ識別文字列パース用の `parseRepository` 純粋関数を追加。比較検証ツール `scripts/compare-rest-graphql.ts` のために独立した REST PR 詳細取得メソッド `getPullRequestDetailsRest` を提供し、GraphQL 化後も正当な REST vs GraphQL の整合性差分検証を保証。`progress.ts` の診断ログ `logRateLimit` において GraphQL レート制限情報の優先表示に対応
- `src/api/graphql-types.ts`, `src/api/graphql-adapters.ts`, `src/models/api-compare.ts`, `src/domain/compare-api.ts`, `scripts/compare-rest-graphql.ts`, `package.json`: GitHub API の GraphQL 一本化に向けた Phase 0（比較検証の土台）を追加（Issue #48）。GraphQL の検索・PR詳細・タイムライン・レート制限レスポンスを既存ドメイン型・API型（`GitHubSearchItem`, `GitHubDetailedSearchResult`, `GitHubPrView`, `ProgressPrDetail`, `ProgressTimelineEvent`, `GitHubRateLimitBucket`）へ安全にマッピングする純粋関数アダプタ群を実装。同一クエリ・PR を REST と GraphQL の両方で並行取得し、件数・PR番号集合・フィールド値・ドメイン判定結果（`hasBlockingOrDraftHistory`, `simulateReadySince`）の差分を検証する読み取り専用診断ツール `scripts/compare-rest-graphql.ts`（`bun run compare:api`）を追加。実 API 検証において、検索総件数（13,626 件）の完全一致（差 0）、取得順序・主要フィールド・PR詳細の完全一致、およびタイムラインのドメイン判定結果のミリ秒一致を確認
- `src/domain/chart.ts`, `src/domain/forecast.ts`, `src/models/depths.ts`, `src/api/github.ts`, `src/domain/depths.ts`, `scripts/build-pages.ts`: ダッシュボードの時系列チャートを 2 軸（左 Y 軸＝待ち件数、右 Y 軸＝先頭の遅れ日数）4 系列（実質待ち・累積待ち・優等生の底遅れ・🌱 初回提出者の底遅れ）のインライン SVG チャート `renderDualAxisLineChartSvg` に統合し、旧単独チャートを一本化。未記録期間の安全なフォールバック描画に対応。ページ最上部にスクロールなしで結論が把握できる「🎯 初回提出者（純粋FIFO）サマリー」カードを新設（P50/P75 予想マージ日・残り目安日数・追い越し実態の分離内訳、未観測・旧形式・未判定の安全なフォールバックと観測可能範囲への表現限定）。マージ実績統計セクションにおいて「🌱 初回提出者コホート実績（純粋FIFO）」を独立ブロックとして分離し、全体実績との対比を強化。REST Search API で探索した `StaleBottom` にも作者情報（`Author` / `AuthorAssociation`）を抽出・保存し、「優等生の底」と「🌱 初回提出者の底」を PC 幅で 2 カラム横並び配置にして優等生の底側で除外された常連 PR に `常連除外` バッジを表示。サンプル一覧テーブルのコホート種別バッジを色分け（`🌱 初回` は緑系強調、`⚡ 常連` は控えめグレー、`⏳ 未判定` は薄字破線）。`depths-history.jsonl` から初回提出者の底の先頭推移を取り出す純粋関数 `extractFirstTimerFrontierSamples` を追加
- `src/domain/first-timer.ts`, `src/models/progress.ts`, `src/models/sample-cache.ts`, `src/domain/sample-cache.ts`, `src/domain/benchmark.ts`, `src/cli/progress.ts`, `scripts/build-pages.ts`: マージ済み PR の統計集計において「初回提出者コホート（1コミット・初期健康体・累計マージ1件）」の分離および「追い越し比較」におけるノイズ分離を追加。タイムライン履歴から途中で阻害要因（阻害ラベルやDraft化・公開復帰 `converted_to_draft`, `ready_for_review`）が発生したPRを手戻りありとして除外（`hasBlockingOrDraftHistory` / `isFirstTimerSampleCandidate`）。バッチ内複数回登場作者を常連として除外し、単発作者に対して GitHub GraphQL API によるエイリアスクエリで全期間累計マージ数を一括照会。真の初回提出者（累計マージ1件）の通算所要日数統計（中央値・75%点・サンプル数）を算出してスナップショットおよびサンプルキャッシュ（`merged-samples.jsonl`）に記録。「追い越しの比較」において常連・特急レーンによる追い越し、初回提出者による追い越し、未判定（旧キャッシュ等）を独立して分離集計し、ダッシュボードおよびコンソールログに内訳を表示。旧形式キャッシュの複数コミットPR（`commitCount > 1`）を自動的に非初回として確定・永続化。ダッシュボードに「初回提出者コホート実績」カードを追加し、サンプル一覧テーブルにコホート種別（初回/常連）を表示
- `src/cli/explore-depths.ts`, `src/domain/depths.ts`, `src/models/depths.ts`, `scripts/build-pages.ts`: 深度探索において「遭難の底」を「優等生の底」に改名し、新セクション「初回提出者の底（First-Timer Bottom）」を並列追加。GraphQL API を使用して更新順の健康体から常連コントリビューター（`authorAssociation !== NONE` または複数コミット）を除外し、純粋な初回提出者（1コミット・初期健康体）の順番待ち先頭を特定・表示できるように対応
- `src/api/github.ts`: GitHub GraphQL API クライアントメソッド `graphql<T>(query, variables)` を追加。トークン未設定時の 401 例外、HTTP エラー時のステータス付き例外、GraphQL errors 返却時のメッセージ付き例外、およびレスポンスの data フィールド抽出をサポート
- `bunfig.toml`: `minimumReleaseAge = 259200`（3 日）を追加。公開から 3 日未満の版を新規に解決しない。lock file maintenance は Renovate の minimumReleaseAge を迂回するため、無人の自動マージに対する防御としてパッケージマネージャ側で止める
- `src/domain/exit-breakdown.ts`, `src/models/exit-breakdown.ts`, `src/cli/progress.ts`, `src/domain/progress.ts`, `scripts/build-pages.ts`: 待ち行列からの離脱の内訳を追加（Issue #18）。実質待ち（更新順の順位）の減少を、マージ・未マージのクローズ・健康条件の変化など（推定）・更新による順位の入れ替わり（推定）に分解し、1 日あたりの件数と、減少のうち実際のマージが占める割合をダッシュボードに表示する。観測のたびに、基準 PR の起票以降にマージ・クローズされた、起票が基準 PR より前で必須ラベルが付いた PR の累積件数を検索で数え、履歴 CSV の `MergedOlder` / `ClosedOlder` 列へ記録する（旧い行は空欄のまま温存し、記録のある観測が 2 回以上たまるまで内訳は出さない）。観測の間隔が 6 時間未満、または累積件数が減っているなど記録が矛盾しているときは、内訳を出さず理由を示す。件数の取得に失敗したら、握りつぶさず中断する
- `src/cli/progress.ts`, `src/domain/sample-cache.ts`, `src/models/sample-cache.ts`, `scripts/sync-dropbox.ts`, `.github/workflows/observe.yml`: マージ済み PR のサンプルキャッシュ（`merged-samples.jsonl`）を追加（Issue #18）。マージ済み PR の履歴は不変なので、計測結果を保存して再利用し、統計を期間内（30 日）のキャッシュ全件で計算する。1 回の実行で新規に取得するのは、新しくマージされた PR と未取得の古い PR（新しい順）を `--fetch-budget` 件まで。API の消費量を一定にしたまま、数日かけて統計の件数が 30 件から数百件へ増える。除外した PR も記録して再取得を避け、計測が途中で失敗しても取得済みの分は保存する。壊れたキャッシュは行番号つきで中断する。Dropbox の同期対象に追加し、ワークフローで `--cache-path` を指定
- `src/api/github.ts`, `src/cli/progress.ts`: レート制限の残量（core と search）を取得する `getRateLimit` と、実行の最後（失敗時を含む）に残量を出す `[RateLimit]` ログを追加（Issue #18）。取得に失敗しても計測の成否には影響させず、警告として残す
- `src/cli/record-forecast.ts`, `src/domain/forecast-history.ts`, `src/models/forecast-history.ts`, `scripts/sync-dropbox.ts`, `.github/workflows/observe.yml`: 観測のたびに 3 つの仮説の予想日を `forecast-history.jsonl` へ記録し（観測時刻が同じ予想は二重に記録しない）、基準 PR がマージされたら実際のマージ日を 1 回だけ記録する CLI を追加（Issue #18）。Dropbox の同期対象に加え、ワークフローでは計測結果の保存後に記録して再保存する（予想の記録が失敗しても計測は失われない）。マージ日が記録された基準 PR は、仮説・モデルごとに予想誤差（予想日 − 実際のマージ日）の平均・平均絶対・最後の予想を採点できる
- `scripts/build-pages.ts`: ダッシュボードに「予想の答え合わせ」を追加（Issue #18）。結果が出るまでは記録件数を示し、結果が出たら基準 PR ごとに採点表を表示。予想履歴は公開データとしてコピーしフッターからリンクする。壊れた履歴は空の採点を出さず中断する
- `src/domain/forecast-comparison.ts`: 表示と記録で入力が同じになるよう、スナップショットと履歴から比較の入力を組み立てる `buildForecastSource` を追加（Issue #18）
- `src/domain/forecast-comparison.ts`, `src/models/forecast-comparison.ts`, `src/domain/chart.ts`, `scripts/build-pages.ts`: ダッシュボードの最上部に、マージ時期を 3 つの仮説（① 順位消化＝実質待ち件数が直近の速度で減る、② 更新順＝更新の古い順に処理される、③ 作成順＝通算所要日数が実績どおり）で予想して比較するパネルを追加（Issue #18）。見出しに主な予想日の範囲、今日から予想日までの時間軸（範囲の帯つき）、仮説ごとの前提・現在の進捗（③ は進捗バー）・予想日を示す。範囲の計算は純粋関数 `calculateForecastComparison`、時間軸は `renderTimelineSvg`。単一の日付は出さない（どの仮説が実態に近いかはまだ検証できていないため）
- `src/domain/chart.ts`, `scripts/build-pages.ts`: ダッシュボードに推移チャート（インライン SVG の折れ線）を追加（Issue #18）。「待ち件数の推移」（実質待ち・累積待ち）と、マージ時期の予想の節の「先頭の遅れの推移」。横軸は JST、縦軸の目盛りは 1・2・5 刻みのきりの良い値。観測が 2 件に満たないときは理由を表示。ライト/ダークは CSS 変数で追従し、外部ライブラリは使わない
- `src/domain/forecast.ts`, `src/models/forecast.ts`, `scripts/build-pages.ts`: マージ時期の予想に、通算所要日数ベース（作成順の消化）の第 3 の予想を追加（Issue #18）。基準 PR の起票日に、直近のマージ実績の通算所要日数の中央値・75%点を足して予想日を出す。更新の入れ替わりの影響を受けないため、他の 2 つ（更新の古い順に処理される前提）とのずれから、どちらの前提が実態に近いかを見る手掛かりになる。統計が無い旧スナップショットでは算出不能と表示
- `scripts/build-pages.ts`: ダッシュボードに、移植時に失われていた指標を復元（Issue #18）。日数統計カードに最大値と基準 PR の現在値・位置づけ（中央値までの残り、サンプルの何 % より待っているか）、採用数・除外数とサンプル不足の注記、追い越しの比較（判定付き）、直前のライバル PR（更新からの経過付き）、比較に使ったサンプル一覧（折りたたみ）、真の大底の行を追加。特急レーンは 5 件まで表示。旧スナップショット（新フィールドなし）でも描画できる
- `src/domain/benchmark.ts`: 基準 PR をマージ済みサンプルと見比べる純粋関数を追加（Issue #18）。追い越しの判定（自分より後に作成・成立してマージ済みの件数）、中央値・75%点までの残り日数と「サンプルの何 % より待っているか」の位置づけ、およびその説明文
- `src/cli/progress.ts`: 移植時に出力されなくなっていた旧スクリプトの項目を復元（Issue #18）。直前のライバル PR（起票・更新日時付き）、条件成立後の統計、参考目安、追い越しの比較、サンプル数と除外件数、サンプル一覧。位置づけには「サンプルの何 % より待っているか」を追加し、条件成立後にも目安を出す
- `src/models/progress.ts`: スナップショットに、最大値、取得期間、サンプル数・除外件数、ライバル PR、サンプル一覧、追い越しの比較、位置づけを追加（ダッシュボードの入力。旧スナップショットでも描画できるよう任意扱い）
- `scripts/build-pages.ts`: ダッシュボードに「マージ時期の予想」を追加（Issue #18）。遭難の底の推移（`depths-history.jsonl`）から、定常待ち時間モデルと観測速度モデルの予想日、先頭の遅れ、直近の先頭の推移を、既存の ETA と並列に表示。算出不能のときは理由を表示し、履歴が壊れている場合は中断
- `scripts/build-pages.ts`: 遭難の底（更新が古い順の健康な PR 上位 10 件と更新からの経過）を専用の表として追加し、「指摘なく順番待ちする PR の先頭」として説明（Issue #18）
- `src/domain/forecast.ts`, `src/models/forecast.ts`: 遭難の底（更新が最も古い健康な PR。指摘なく順番待ちをする基準 PR と同種の PR）の推移から基準 PR のマージ時期を予想するモデルを追加（Issue #18）。先頭の遅れが一定とする「定常待ち時間モデル」と、履歴から先頭の進み（日/日）を実測する「観測速度モデル」を並列に算出し、進みが観測できない場合は理由付きで算出不能とする。`depths-history.jsonl` のパースと観測列の抽出も純粋関数として提供
- `src/api/github.ts`, `src/domain/depths.ts`, `src/models/depths.ts`: キュー境界スナップショットの基準 PR 情報に最終更新時刻（`UpdatedAt`）を追加（予想モデルの入力）
- `tsconfig.json`, `package.json`, `.github/workflows/ci.yml`, `lefthook.yml`: strict な型チェック（`tsc --noEmit`、`bun run typecheck`）を導入し、CI と pre-commit に組み込み（Issue #18）
- `src/models/dashboard.ts`, `src/domain/dashboard.ts`: ダッシュボード算出メトリクス（直近24時間の消化速度 Velocity・到着予測 ETA、前回観測比の増減差分 Δ、前線と自 PR の起票日カレンダー距離、実績所要日数パーセンタイル集計）を算出するドメイン純粋関数および型定義を追加（Issue #12）
- `test/domain/dashboard.test.ts`: ダッシュボード算出メトリクスの単体テストを追加
- `scripts/build-pages.ts`: 到着予測 (ETA) & 消化速度カード、前線カレンダー距離カード、マージ実績所要日数（手番・Ready・通算）統計セクション、および直近ログテーブルへの Δ 差分バッジ表示を追加
- `src/cli/generate-summary.ts`, `src/domain/summary.ts`, `src/models/summary.ts`: サマリーダッシュボード生成（`generate-summary` -> `SUMMARY.md`）の TypeScript (Bun) 実装を追加（Issue #7 Phase 3）。キュー状況・Mermaid 構造図・統計比較・境界探索・推移履歴を含む Markdown 生成純粋関数および CLI を配備
- `test/domain/summary.test.ts`, `test/cli/generate-summary.test.ts`: サマリー生成のドメイン純粋関数および CLI 引数・cwd 独立性・データ読み込みの単体テストを追加
- `src/models/progress.ts`, `src/domain/progress.ts`, `src/cli/progress.ts`: 進捗メトリクス計測（`progress-winget`）の TypeScript (Bun) 実装を追加（Issue #7 Phase 2）。ラベル判定（必須・阻害・調査中・パターン除外）、線形補間パーセンタイル計算、タイムラインシミュレーションによる条件成立日時（ReadyAt）特定、および CSV 履歴・JSON スナップショット出力 CLI を配備
- `test/domain/progress.test.ts`, `test/cli/progress.test.ts`: 進捗メトリクス計測のドメイン純粋関数および CLI 引数・cwd 独立性・モック API 実行の単体テストを追加
- `src/api/github.ts`: REST API による PR 詳細取得（`getPullRequestDetails`）、タイムライン取得（`getIssueTimeline`）、および検索詳細取得（`searchIssuesDetailed`）メソッドを追加
- `src/models/depths.ts`, `src/domain/depths.ts`, `src/api/github.ts`, `src/cli/explore-depths.ts`: キュー境界探索（`explore-winget-depths`）の TypeScript (Bun) 実装を追加（Issue #7 Phase 1）。I/O 非依存の純粋関数ドメイン、Bun 標準 fetch による GitHub API クライアント、および JSONL/JSON 永続化 CLI を配備
- `test/domain/depths.test.ts`, `test/api/github.test.ts`, `test/cli/explore-depths.test.ts`: キュー境界探索のドメインロジック、API クライアント、CLI 動作の単体テストを追加
- `test/architecture.test.ts`: `src/domain` および `src/models` の境界違反（外部 I/O 依存、暗黙の環境変数依存、レイヤー逆参照）をホワイトリスト方式で機械的に検知するアーキテクチャ境界テストを追加
- `scripts/lib/dropbox.ts`, `scripts/lib/redact.ts`: 外部依存なしで動作する Dropbox App Folder 連携クライアントおよび機密情報サニタイズ処理
- `scripts/sync-dropbox.ts`: `data/` 配下の観測メトリクス（CSV, JSONL, JSON）と Dropbox App Folder の自動同期スクリプト
- `scripts/build-pages.ts`: 観測データからレスポンシブな Web ダッシュボード（`site/index.html`）を生成する HTML ビルドスクリプト
- ユニットテスト群（`test/dropbox.test.ts`, `test/redact.test.ts`, `test/build-pages.test.ts`, `test/sync-dropbox.test.ts`）

### Changed

- `src/models/depths.ts`, `src/models/forecast.ts`, `src/domain/depths.ts`, `src/domain/forecast.ts`, `src/cli/explore-depths.ts`, `scripts/build-pages.ts`, 関連テスト: 「🧗 優等生の底」と「🌱 初回提出者の底」の抽出条件・役割を分離し、データモデルおよびダッシュボード表示・チャート指標の整合を改善（Issue #74）。
  - `StaleBottom` に 1 コミット限定（`isStaleCandidate`）の GraphQL ページング抽出（`fetchStaleBottom`, `sort:updated-asc`）を導入し、「1 コミット完全放置」の純度を担保
  - `FirstTimerBottom` を起票日時昇順（`sort:created-asc`）へ移行し、`authorAssociation === "NONE"` に加えて `buildAuthorMergedCountQuery` による生涯マージ 0 回検証とページング補完を追加（複数コミット・手直し込みを許容）
  - `DepthsRow` にオプショナルな `CommitCount` を追加し、ダッシュボード「🌱 初回提出者の底」テーブルに「コミット数」列（旧データは `-`）および新説明文・バッジを表示
  - 統合時系列チャートの右軸を「先頭の経過・遅れ（日）」へ整理し、`extractFirstTimerFrontierSamples` が `CreatedAt` を抽出して「🌱 初回提出者の底 起票からの経過」を描画するよう変更
  - `DepthsSnapshot` に観測定義バージョン `DepthsVersion`（`CURRENT_DEPTHS_VERSION = 2`）を導入し、`extractStaleFrontierSamples` / `extractFirstTimerFrontierSamples` による時系列・速度算出から旧定義スナップショットを除外して条件切替による偽速度を防止
- `src/domain/dashboard.ts`, `src/domain/exit-breakdown.ts`, `src/domain/forecast-comparison.ts`, `scripts/build-pages.ts`, 関連テスト: 仮説①（順位消化）および「待ち行列からの離脱の内訳」の基準ルックバック期間（母時間）を 24 時間から 1 週間（168 時間）へ延長し、ダッシュボード UI の期間表記を日数・時間併記（`X.X 日（XXX.X 時間）` / `XXX.X 時間 / X.X 日`）へ更新（Issue #73）。
  - `calculateVelocityMetrics` / `calculateDashboardMetrics` / `calculateExitBreakdown` の既定窓を `168` 時間（`DEFAULT_VELOCITY_WINDOW_HOURS`, `DEFAULT_EXIT_WINDOW_HOURS`）へ引き上げ（168 時間未満の履歴では最古レコードへフォールバック）
  - これに伴い、`forecast-history.jsonl` に記録される `rank-velocity` の予想日も本変更以降の観測から 168 時間窓ベースへ切り替わる
- `src/domain/search-window.ts`, `src/domain/sample-collector.ts`, `src/domain/progress-format.ts`, `src/cli/progress.ts`, `src/models/progress.ts`, `src/api/github.ts`, `test/domain/search-window.test.ts`, `test/domain/sample-collector.test.ts`, `test/domain/progress-format.test.ts`, `test/cli/progress.test.ts`: マージ済み PR 走査方式を、更新日時順ソート下でのマージ日時逆転による未走査候補の欠落を原理的に排除しつつ、1,000 件以内の平常期間は単一窓で最速走査し過密窓のみ時間範囲を二分する「動的二分窓走査方式（Dynamic Bisecting Window Queue）」へ刷新し、`progress.ts` の肥大化した責務を分離・モジュール化（Issue #68 Phase 3）。
  - 更新日時順とマージ日時の逆転による未取得 PR のスキップ欠落を防ぐ動的二分探索窓走査関数 `collectMergedCandidates` を導入。1 ページ内での `fetchLimit` の厳格な遵守および 1,000 件境界の安全な全件取得を保証
  - サンプルの収集・キャッシュ管理・初回提出者判定・詳細取得・累計マージ数照会のオーケストレーションを `src/domain/sample-collector.ts` へ純粋ドメイン関数として分離
  - コンソール出力およびログ整形の責務を `src/domain/progress-format.ts` へ分離
  - `src/cli/progress.ts` のコード行数を約 980 行から 538 行へ大幅にスリム化（約 440 行削減）し、保守性と単体テスト容易性を向上
- `README.md`: マージ済み PR 詳細取得予算 `--fetch-budget` の既定値記載を 100 から 300 へ更新。初回提出者コホートの新仕様（90 日窓、生涯 1 件マージ全体、通算所要日数および Turn Latency 併記）、キュー境界の初回提出者の底、Cloudflare Workers（`observe-trigger`）による定時トリガーおよび Wrangler Secrets 同期スクリプトの記載を最新化（Issue #68）
- `src/cli/progress.ts`, `test/cli/progress.test.ts`: マージ済み PR の詳細（タイムライン・PR詳細）取得予算 `--fetch-budget` の既定値を 100 から 300 へ引き上げ（Issue #66）。90 日間の初回提出者候補および 30 日間の全体枠を合わせても実質 200 件前後であるため、初回実行やキャッシュ移行・再評価を 1 回のワークフロー実行で完了可能にし、保留（deferred）による複数回分割を解消
- `src/domain/first-timer.ts`, `src/domain/progress.ts`, `src/domain/sample-cache.ts`, `src/cli/progress.ts`, `scripts/build-pages.ts`, `test/domain/first-timer.test.ts`, `test/domain/progress.test.ts`, `test/domain/sample-cache.test.ts`, `test/cli/progress.test.ts`, `test/build-pages.test.ts`: 初回提出者コホートにおけるコミット数制限（1 コミット一発通過）を撤廃し、「生涯マージ 1 件の作者全体」をコホート母集団として採用するとともに、通算所要日数と最終コミット後所要日数（Turn Latency）の両指標を集計・表示するよう刷新（Issue #64）。
  - 実データ分析により、初回提出者は CI バリデーションやレビュー指摘による手直し（2〜7 コミット）を経てマージされるのが一般的であり、1 コミット一発通過は極めて稀（90 日間で 3〜4 件のみ）であることが判明
  - `isCandidateEligibleForFirstTimerDetail`, `isFirstTimerSampleCandidate`, `extractSingleHitCandidateLogins` からコミット数制限を撤廃し、非 Draft かつ阻害ラベル履歴のない健康体であれば複数コミットの初回提出者も詳細取得・コホート採用の対象に拡大
  - 旧版キャッシュの自動移行・再評価処理（`shouldReevaluateCachedSample`, `shouldReevaluateSkippedCandidate`）を配備。旧版でコミット数を理由に `IsFirstTimer: false` または `skipped/Reason: not-first-timer-candidate` となっていた既存データを安全に再評価して初回提出者コホートに採用しつつ、タイムライン阻害履歴や期間内重複作者による正当な除外は確実に保持
  - 手直しの有無による所要日数のばらつきを公平に評価・比較できるよう、PR 作成からマージまでの「通算所要日数」に加え、最終コミットからマージまでの「最終コミット後所要日数（Turn Latency）」を集計
  - CLI のベンチマーク出力および GitHub Pages ダッシュボード（Hero カード・実績セクション）において、通算所要日数（P50/P75）と Turn Latency（P50/P75）を併記表示するよう UI を更新
- `src/cli/progress.ts`, `src/domain/first-timer.ts`, `src/api/github.ts`, `src/api/graphql-adapters.ts`, `src/models/sample-cache.ts`, `src/domain/sample-cache.ts`, `test/domain/first-timer.test.ts`, `test/cli/progress.test.ts`, `test/domain/sample-cache.test.ts`: マージ済み PR 探索における Search API 1,000 件制限回避および「初回提出者専用フィルタリング（絞って取る）」による大幅な API 最適化を実施（Issue #62）。
  - `SEARCH_ISSUES_QUERY` の PullRequest ノードに `commits(first: 1) { totalCount }` を追加し、検索一覧取得の時点でコミット数・作者・ドラフト状態・ラベルを軽量メタデータとして一括取得
  - `progress.ts` のマージ済み PR 走査を 14 日単位の日付窓スライス分割走査へ刷新し、単一窓が 1,000 件を超える場合は時間範囲を 1 秒単位まで再帰的に追加分割（bisecting）して漏れなく走査する自己分割処理を追加。1 秒以下でも 1,000 件を超過する極端なマージ集中が発生した場合はサイレントな打ち切りを回避して明示的に例外をスローする安全設計を配備。候補走査上限 `fetchLimit` の既定値を 1,000 から 5,000（上限 10,000）へ拡大
  - 直近 30 日窓（全体実績）は従来通り全体母集団として取得・キャッシュしつつ、31〜90日前（初回提出者専用窓）については 1 コミットでない PR、Draft、阻害ラベル付き PR、同一走査期間内に複数回登場する常連 author を事前除外（`isCandidateEligibleForFirstTimerDetail` / `countCandidateAuthors`）
  - 除外された PR は `Type: "skipped"`, `Reason: "not-first-timer-candidate"` としてサンプルキャッシュに永続化し、次回以降の無駄な再走査を防止。全体集計窓（`lookbackDays`）が拡大された場合は該当 PR のスキップを解除して自動再評価し、全体実績の欠落を防止
  - 走査した全候補における作者出現頻度をキャッシュ済みサンプルの常連判定にも反映し、同作者の別 PR が発見された場合に過去の `IsFirstTimer: true` を確実に `false` へ取り消して永続化
  - フィルターを通過した真の初回候補（数十〜100件程度）のみに詳細（タイムライン・PR詳細・累計マージ数照合）取得を限定することで、リクエスト数を約 97% 削減し、API レート制限（5,000pt/時）および Actions タイムアウト（30分）を回避しながら 90 日分の初回提出者母集団を安全かつ完全に網羅可能に改善
- `.github/workflows/observe.yml`: GitHub Actions 標準の `schedule`（cron）による遅延や間引きを解消するため、定期実行トリガーを Cloudflare Workers の Cron Trigger（`workers/observe-trigger`）からの `workflow_dispatch` 呼び出しへ移行し、ワークフロー内の `schedule:` 定義を廃止（Issue #58）。多重実行防止のための `concurrency`（`cancel-in-progress: false`）は継続して維持
- `package.json`: `typecheck` スクリプトをルートおよび `workers/observe-trigger/` の両方を一括検証するよう更新（Issue #58）
- `src/cli/progress.ts`: `--sample-size`（統計に使う件数、既定 30、上限 100）を `--fetch-budget`（1 回の実行で新規に取得する件数、既定 100、上限 100）へ置き換え、`--cache-path` を追加。キャッシュを使わない場合は、従来どおり取得した件数だけで統計を計算する（Issue #18）
- `src/domain/benchmark.ts`, `scripts/build-pages.ts`: 採用サンプルが数百件になるため、スナップショットのサンプル一覧はマージが新しい順に 30 件までとし、統計・比較は全件で計算する。ダッシュボードの見出しは統計に使った総数、一覧は新しい順の一部であることを示す（Issue #18）
- `scripts/build-pages.ts`: 予想パネルに統合したため、上部の「到着予測 (ETA) & 消化速度」カードと、マージ時期の予想の節の 3 枚のカード（定常待ち時間・観測速度・通算所要日数ベース）を削除。予想の節は「仮説② の根拠」（先頭の遅れのチャートと直近の観測）に改め、予想日は最上部のパネルに一本化（Issue #18）
- `scripts/build-pages.ts`: ダッシュボードの表示を整理（Issue #18）。トリアージキュー構造の図は、前線と基準 PR の間を作成順の累積待ち（起票日の差つき）とし、更新順の順位は基準 PR のノードに示す（従来は更新順の順位が作成順の区間に書かれて食い違って見えた）。「健康的大底」のノードは消化前線と同じ PR になったため統合。追い越しの表から、起票日と実質同じ意味になる PR 番号の 2 行を削除（スナップショットと CLI ログには残す）。統計カードの P50 / P75 / 最大が途中で折り返さないよう調整。favicon を埋め込み 404 を解消
- `scripts/build-pages.ts`: マージ時期の予想の節の「先頭の遅れ」の表を、推移チャートに代わるため直近 10 件から 5 件に縮小（Issue #18）
- `scripts/build-pages.ts`: ダッシュボード上部の到着予測（ETA）に、実質待ち件数（更新順の順位）の変化から算出するため、前にいた PR の更新による順位の入れ替わりを含み、実際の消化より速く出ることがある旨の注記を追加。マージ時期の予想の節に、3 つの予想の前提の違いを説明する注記を追加（Issue #18）
- 同じ形で入力だけが異なるテストを `test.each` に集約（Issue #18）。対象は `test/domain/progress.test.ts`（ラベル判定・パーセンタイル・書式）、`test/domain/dashboard.test.ts`（タイムスタンプ解釈・カレンダー距離・差分バッジ）、`test/redact.test.ts`、`test/dropbox.test.ts`、`test/sync-dropbox.test.ts`（資格情報検証）、`test/cli/progress.test.ts`・`test/cli/explore-depths.test.ts`（引数の拒否）。ケースごとに名前が付き、失敗時に原因の入力が分かる。アサーション数は変わらない（625）。1 件のシナリオを検証するテストは対象外
- `src/cli/args.ts`: 各 CLI に複製されていた引数検証（値の取得・後続フラグの誤消費防止・整数範囲・基準 PR の環境変数解決）と、既定の基準 PR・リポジトリの定数を共通化。`progress` / `explore-depths` / `build-pages` に散在していたハードコードを置換し、`test/cli/args.test.ts` を追加（Issue #18）
- `scripts/build-pages.ts`: `models/` の型（`ProgressSnapshot` / `DepthsSnapshot` / `ProgressHistoryRow`）と `domain` の `parseCsvRows` を再利用するよう変更し、独自の型定義・CSV パーサ・数値整形の重複を削減。数値が空欄の項目を `0` ではなく `-` と表示（Issue #18）
- `src/cli/progress.ts`, `src/domain/progress.ts`, `src/models/progress.ts`, `src/api/github.ts`: 待ち行列の指標を再設計（Issue #18）。消化前線を「直近マージ PR」から「条件を満たす最古の未マージ PR」に変更して単調に進むようにし、実質待ちを「更新順で自 PR より前に並ぶ健康な PR の数」（指摘なく順番待ちをしている PR の待ち順位）に変更。履歴 CSV に算出基準を示す `QueueBasis` 列を追加し、旧定義の行（空欄）との前回比は出力しない
- `src/domain/progress.ts`, `src/domain/depths.ts`: 「健康な PR」の検索条件を `buildHealthyQueryParts` に一本化し、`progress` と `explore-depths` で除外ラベルの定義がずれていた問題を解消
- `src/cli/explore-depths.ts`: 遭難の底（更新が最も古い健康な PR）の取得件数を 3 件から 10 件に拡張
- `README.md`: 累積待ち件数の定義を実装（検索ヒット件数）に合わせて修正し、`progress` / `explore-depths` の主なオプション、基準 PR が観測対象外のときの挙動、前提 Bun のバージョン指針（`.bun-version`）、`data/` ディレクトリの位置づけを追記（Issue #18）
- `scripts/build-pages.ts`: 「手番所要日数」の説明を実装（最新コミット→マージ）に合わせて修正（Issue #18）
- `src/domain/progress.ts`, `scripts/lib/dropbox.ts`: パーセンタイル算出方式の注記（R-7）と Dropbox 保存先パスのコメントを実装に合わせて修正（Issue #18）
- `renovate.json`, `.gitattributes`: PowerShell 退役後も残っていた PowerShell 用のプリセットと `*.ps1` の改行設定を削除（Issue #18）
- `.github/workflows/observe.yml`: 定期メトリクス収集ステップを PowerShell (`pwsh`) から Bun / TypeScript スクリプト（`src/cli/progress.ts`, `src/cli/explore-depths.ts`, `src/cli/generate-summary.ts`）のネイティブ実行へ刷新し、外部プロセス依存を完全排除
- `README.md`: PowerShell スクリプトから Bun / TypeScript CLI コマンド（`bun run progress`, `bun run explore:depths`, `bun run summary`）への案内へ更新
- `scripts/lib/dropbox.ts`: Dropbox アプリフォルダー内の二重階層を解消するため、保存先プレフィックス `DROPBOX_ROOT` を `/winget-observatory/` から `/data/` へ変更。移行互換用として旧プレフィックス `LEGACY_DROPBOX_ROOT`（`/winget-observatory/`）の読み取りを許容
- `scripts/sync-dropbox.ts`: 新パス `/data/` にファイルが存在しない場合に旧パス `/winget-observatory/` から履歴データを自動取得・引き継ぐフォールバック機能（`downloadMetricsFiles`）を追加し、手動移行作業不要のシームレスな移行を保証
- `.github/workflows/observe.yml`: `main` 直 push を全廃し、Dropbox への生データ保存および `actions/deploy-pages` による GitHub Pages 直接デプロイへ刷新（ブランチ保護ルールを完全遵守）
- `.github/workflows/ci.yml`: `bun test` による TypeScript ユニットテストステップを追加
- `package.json`: `test`, `build:pages`, `sync:dropbox` スクリプトを追加
- `README.md`: Dropbox 連携および GitHub Pages による自動化運用に関するドキュメントを更新

### Fixed

- `src/api/github.ts`, `test/api/github.test.ts`: GitHub GraphQL API において HTTP 200 応答だが空文字・空白のみ・HTML エラー画面・不完全構文等で JSON パースに失敗した場合に、一時的通信エラーとして指数バックオフ付きで自動リトライするよう耐障害性を強化（Issue #68）。ロードバランサーやプロキシの一時的な瞬断（空ボディ返却）によるワークフロー中断を解消
- `src/domain/depths.ts`, `src/models/depths.ts`, `src/cli/explore-depths.ts`, `src/domain/forecast.ts`, `test/domain/depths.test.ts`, `test/cli/explore-depths.test.ts`: `explore-depths` の「初回提出者の底（First-Timer Bottom）」判定（`isFirstTimerCandidate`）に残存していた 1 コミット制限を撤廃し、PR #65（初回提出者コホートのコミット数制限撤廃）と仕様を整合（Issue #68）。手直しコミットを経た健康な初回提出者のオープン PR も正しく順番待ち先頭として反映されるよう修正
- `.github/workflows/observe.yml`: GitHub Actions ワークフローにおいて、`progress` 実行と `explore-depths` 実行をステップ分離し、`progress` 完了直後にサンプルキャッシュ（`data/merged-samples.jsonl` 等）を Dropbox へ即座に書き戻すステップを追加（Issue #56）。さらに後続の Dropbox 保存ステップに `if: always()` を付与し、後続処理の失敗時にもバックフィル済みキャッシュの消失を防ぐよう耐障害性を強化
- `src/cli/explore-depths.ts`: 初回提出者の底（First-Timer Bottom）の GraphQL クエリ走査において、固定件数による候補取りこぼしを防ぐためページネーション（`pageInfo`）を導入し、採用件数（10件）または検索結果の終端まで走査するよう修正。走査上限に達して未走査の PR が残る場合は候補なしと誤認させず例外で中断し、GraphQL 通信・認証エラーの握りつぶしも撤廃して不完全なデータの保存を防止
- `src/domain/dashboard.ts`, `scripts/build-pages.ts`: ダッシュボードの履歴処理を `selectComparableHistory` に切り出して是正（Issue #18）。基準 PR が異なる行、待ち件数の算出基準（`QueueBasis`）が現行と異なる旧定義の行を速度・前回比・推移表から除外し、数値が空欄の行を `0` 件として扱って速度や ETA を歪めていた問題を解消。ラベル表記も「実質待ち件数（更新順の順位）」「作成順の累積」に修正
- `scripts/build-pages.ts`: 進捗・境界スナップショットおよび履歴 CSV の読み込み失敗を `console.warn` で握りつぶして空のダッシュボードを公開していた問題を修正し、ファイルパス付きで中断（exit 1）するよう変更（Issue #18）
- `src/cli/explore-depths.ts`: 基準 PR の取得失敗時に基準 PR 無しのスナップショットを履歴 JSONL へ追記して続行していた問題を修正し、中断するよう変更。エントリポイントの引数エラーも他 CLI と同じ書式で報告（Issue #18）
- `src/cli/progress.ts`, `src/domain/progress.ts`, `src/models/progress.ts`: 履歴 CSV の読み込み失敗とマージ済みサンプル計測の失敗（`failed++` で黙殺していた）を PR 番号・パス付きで中断するよう変更し、常に誤解を招いていた `failedCount` を廃止。基準 PR が観測対象外で記録がスキップされた場合は Actions の warning を出力（Issue #18）
- `scripts/sync-dropbox.ts`: `--direction` の値欠落・未指定が暗黙の upload になる問題と、未知引数が無視される問題を修正し、厳格に拒否するよう変更（Issue #18）
- `src/cli/progress.ts`: 複数コミットの PR で最新コミット表示の区切り文字のハイフンが二重になる問題を修正し、回帰テストを追加（Issue #18）
- `src/domain/progress.ts`: `formatDateTimeWithDay` が `getTimezoneOffset` とローカル時刻の getter を併用しており実行環境のタイムゾーンに依存していたため、`getUTC*` ベースに統一し、日跨ぎ・別タイムゾーンのテストを追加（Issue #18）
- `test/cli/progress.test.ts`: `process.env` オブジェクト自体を置換していた復元処理を、変更したキーのみの復元に修正（Issue #18）
- `src/api/github.ts`: `GitHubApiClientOptions.fetch` を `typeof fetch` から呼び出しシグネチャのみの `FetchLike` へ変更し、モック注入時の型エラー（`preconnect` 欠落）を解消。タイムライン取得ループの暗黙 any を明示的な型注釈で解消（Issue #18）
- `bun.lock`: `package.json` と食い違っていた `@biomejs/biome` の specifier を再生成で整合（Issue #18）
- `package.json`: `lint` スクリプトが `--write` でファイルを書き換えていたため検査のみに変更（修正は `check:fix`）（Issue #18）
- `.github/workflows/ci.yml`, `observe.yml`, `prepare-release.yml`: ジョブに `timeout-minutes` を設定し、API 待ちなどによる無制限のハングを防止（Issue #18）
- `README.md`: Dropbox 保存先パス（`/data/`）、前提ツール（PowerShell 依存削除）、ロードマップ（Pages ダッシュボード完了）、および定期観測ダッシュボードの閲覧案内を最新実装に合わせて更新し、Codecov バッジを追加（Issue #16）
- `.github/workflows/observe.yml`: 定期観測ワークフローに防御的な `bun install --frozen-lockfile` ステップを追加し、将来の依存追加時の潜在リスクを排除（Issue #16）
- `.github/workflows/ci.yml`: `id-token: write` パーミッションおよび `codecov/codecov-action` ステップを追加し、GitHub Actions の OIDC 認証（トークンレス）を用いた Codecov へのカバレッジ自動送信を有効化（Issue #14）
- `package.json`, `.gitignore`: カバレッジ計測コマンド `test:coverage`（`bun test --coverage --coverage-reporter=lcov`）を追加し、出力先 `coverage/` を git 除外対象に設定
- `src/cli/generate-summary.ts`: 観測データ（JSON / CSV）の読み込み・パース失敗時に例外を握りつぶさずファイルパス付きでエラーを伝播させて非ゼロ終了するよう修正
- `src/domain/summary.ts`: PR タイトルに含まれる二重引用符を Mermaid 用にエスケープ（`#quot;`）し、特殊文字による構文破損を防止
- `test/cli/progress.test.ts`: 保存先解決テストで Windows 絶対パスを固定していた問題を解消し、OS 非依存のパス検証に修正
- `src/domain/progress.ts`, `src/models/progress.ts`, `scripts/build-pages.ts`: 進捗スナップショット JSON のキーを既存仕様（PascalCase）に統一し、ダッシュボード側でも大文字・小文字双方に対応する正規化処理と結合テストを追加
- `src/cli/progress.ts`, `src/api/github.ts`: マージ済み候補の検索を 100 件で打ち切らず、`fetchLimit`（既定 1000 件）まで複数ページを自動走査するページネーションを追加
- `src/api/github.ts`: PR コミット一覧取得失敗時に例外を空配列へ握りつぶさず、`GitHubApiError` を正しくスローして誤った計測値の保存を防止するよう修正
- `src/cli/explore-depths.ts`: 既定のデータ保存先が実行時 cwd 依存になっていた問題を解消し、エントリポイント位置からリポジトリルートの `data/` を起点に解決するよう修正
- `src/cli/explore-depths.ts`: `--target-pr` の NaN や負数の許容、値の欠落、後続フラグの誤消費、および未知の引数を厳格に拒否するバリデーションを追加
- `scripts/build-pages.ts`: キュー境界探索の遭難・放置の底の参照キーを `StrandedCandidates` から出力契約である `StaleBottom` へ修正し、ダッシュボード HTML への表示欠落を解消
- `.github/workflows/observe.yml`: 定期観測時の Dropbox 同期ステップから `--allow-skip` を撤廃し、資格情報未設定時に永続化をスキップして Pages 公開へ進まないよう非ゼロ終了を保証

### Removed

- `scripts/compare-rest-graphql.ts`, `scripts/rest-client.ts`, `src/domain/compare-api.ts`, `src/models/api-compare.ts`, `test/scripts/compare-rest-graphql.test.ts`, `test/scripts/rest-client.test.ts`, `test/domain/compare-api.test.ts`, `package.json`: GraphQL 一本化（Phase 4 / #53）完了により役目を終えた REST vs GraphQL 比較検証用スクリプト群、REST クライアント、ドメイン比較モジュール、および関連テスト（計 7 ファイル、約 2,800 行）を全廃（Issue #68）。リポジトリを軽量化し、保守コストおよびテスト実行時間を削減
- `scripts/sync-dropbox.ts`, `scripts/lib/dropbox.ts`: 旧 Dropbox パス `/winget-observatory/` へのフォールバック取得（`downloadMetricsFiles`）、`LEGACY_DROPBOX_ROOT`、`DownloadSummary.fallback`、`assertSafePath` の旧プレフィックス許容を削除（Issue #18）。履歴は `/data/` へ統合済みで、旧フォルダー自体も削除したため、`/data/` に無いファイルは旧パスを探さずスキップする。読み書きできるのは `/data/` 配下だけになる
- `data/` 配下の旧スナップショット（`progress-history.csv`、`depths-history.jsonl`、`latest-*.json`）の git 追跡を廃止し、`.gitignore` に追加（Issue #18）。観測データの正は Dropbox に一本化済みで、旧運用（main への自動コミット）時点の値は更新されないまま誤解を招いていた。削除前に Dropbox `/data/` へ全行が含まれることを確認し、旧フォルダー（`/winget-observatory/`）にだけ存在した履歴 CSV 1 行・境界探索 JSONL 1 行を `/data/` へ統合済み。git 履歴からは削除しない
- 未使用・互換目的のコードを削除（Issue #18）: `progress` の `--queue-limit`（パース・検証のみで未使用）、`simulateReadySince` の `isFinalValidation` / `currentLabels`、`migrateCsvRecord`（内部の `toHistoryRow` へ）、`PercentileStats`、`build-pages.ts` の camelCase キー互換正規化と `StrandedCandidates` 互換
- `src/cli/generate-summary.ts`, `src/domain/summary.ts`, `src/models/summary.ts`, 対応するテスト、`SUMMARY.md`、`package.json` の `summary` スクリプト、`observe.yml` の生成ステップ、README の該当節: サマリー（`SUMMARY.md`）生成機能を廃止。cron では生成物がコミットも公開もされず捨てられており、フッターの「定期更新」も事実と異なっていたため、Issue #7 の合意どおり人間向けの閲覧先を GitHub Pages に一本化（Issue #18）
- レガシーな PowerShell 計測スクリプト群（`scripts/progress-winget.ps1`, `scripts/explore-winget-depths.ps1`, `scripts/generate-summary.ps1`, `scripts/check-syntax.ps1`）および PowerShell テスト群（`tests/*.ps1`）を TypeScript 化に伴い完全退役
- `.github/workflows/ci.yml` および `lefthook.yml` から PowerShell 構文検査と PSScriptAnalyzer 検査ステップを退役（Biome & TypeScript Tests に一本化）

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

[Unreleased]: https://github.com/scottlz0310/winget-observatory/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/scottlz0310/winget-observatory/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/scottlz0310/winget-observatory/releases/tag/v0.1.0
