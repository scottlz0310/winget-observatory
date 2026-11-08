# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Fixed

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

### Changed

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

### Removed

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

[Unreleased]: https://github.com/scottlz0310/winget-observatory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/scottlz0310/winget-observatory/releases/tag/v0.1.0
