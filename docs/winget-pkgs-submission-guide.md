# `microsoft/winget-pkgs` 初回パッケージ提出 実践ガイド＆チェックリスト

> **根拠コーパス**: `winget-observatory`（`collect-review-feedback` `schemaVersion = 2`）により収集・精製した、`microsoft/winget-pkgs` 直近 90 日窓（2026-08-30〜2026-11-26）の初回提出（`New package:`）PR **全 3,603 件**（`MERGED` 1,462 件 + `CLOSED` 2,141 件、うち差し戻し・却下 **943 件**［ブロッキング 890 / 非ブロッキング助言のみ 53］、指摘コメント **1,783 件**）。
>
> **併用テンプレート**: PR 作成時は [先回り PR 本文テンプレート](templates/winget-pkgs-pr-template.md) を併用し、メンテナの質問往復を初回から潰してください。

---

## 1. 実データから見る全体傾向と差し戻し・却下の実態

### 1.1 マージ済み PR の観測上の中央値差（`MERGED` 1,462 件実測）

| 区分                                                 |     件数 | 起票→マージ中央値 | 差し戻しなしとの差 |
| ---------------------------------------------------- | -------: | ----------------: | -----------------: |
| 差し戻しなし（無傷 PR / 定型運用ノイズのみ含む）     | 1,076 件 |       **30.3 日** |               基準 |
| 差し戻しあり全体（`feedback` 全体）                  |   386 件 |       **46.4 日** |       **+16.1 日** |
| うちブロッキング差し戻しあり                         |   333 件 |       **44.7 日** |       **+14.4 日** |
| うち非ブロッキング助言のみ（長期滞留後の最終確認等） |    53 件 |       **53.4 日** |       **+23.1 日** |

マージ済み PR を差し戻し・助言の有無で比較すると、`feedback` あり全体（386 件）の起票→マージ中央値は **46.4 日**、なし（1,076 件）は **30.3 日** で、観測上 **+16.1 日の中央値差** があります。なお、本集計には差し戻し時刻やキュー順位の前後比較が含まれていないため、差し戻しが待ち時間を延ばしたのか、長く滞留した PR ほど後から指摘・助言を受けたのかの因果関係まではこの表だけで切り分けられません（特に非ブロッキング助言のみの中央値が 53.4 日と高い点も長期滞留後の確認を反映している可能性があります）。一方で、未マージで終了（`CLOSED`）した差し戻し・却下 PR も **557 件** 観測されており、初回提出前に頻出論点を潰しておく実務的価値は明確です。

### 1.2 カテゴリ別発生頻度（統合 943 件・マルチタグ集計）

| 順位 | カテゴリ                                                          |    統合 (943件) | `MERGED` (386件) | `CLOSED` (557件) | 主な論点                                                                           |
| ---: | ----------------------------------------------------------------- | --------------: | ---------------: | ---------------: | ---------------------------------------------------------------------------------- |
|    1 | マニフェスト構造・インストーラー・ARP 整合 (`manifest-installer`) | **320** (33.9%) |      150 (38.9%) |      170 (30.5%) | ARP 値不一致、`UpgradeBehavior`、`Scope`、非推奨 `ManifestVersion`、サイレント失敗 |
|    2 | プライバシーポリシー・データ開示 (`privacy-policy`)               | **265** (28.1%) |      157 (40.7%) |      108 (19.4%) | 外部通信・テレメトリ・認証・AI API 利用時の `PrivacyUrl` 欠落                      |
|    3 | セキュリティ / 署名 / ポリシー制約 (`security-signing`)           | **237** (25.1%) |      151 (39.1%) |       86 (15.4%) | `Policy-Test-*` 検知、未署名/Defender 誤検知、`Scripted-Application`、来歴不明     |
|    4 | メタデータ・URL・ライセンス不備 (`metadata-url`)                  | **200** (21.2%) |      114 (29.5%) |       86 (15.4%) | 404/ハッシュ不一致、`LicenseUrl`/`PackageUrl` 欠落、不変 URL 違反                  |
|    5 | DLL / ランタイム欠損 (`dll-runtime`)                              | **137** (14.5%) |       75 (19.4%) |       62 (11.1%) | クリーン VM での `VCRUNTIME140.dll` 欠損（`0xC0000135` / `STATUS_DLL_NOT_FOUND`）  |
|    6 | 起動・コマンド・VM 動作不良 (`launch-command`)                    | **134** (14.2%) |       87 (22.5%) |        47 (8.4%) | CLI 引数なし終了コード、OpenGL 1.1 制約、画面外描画、起動直後終了                  |
|    7 | UI 言語・Locale 不一致 (`locale-language`)                        |   **62** (6.6%) |       40 (10.4%) |        22 (3.9%) | 実アプリ UI 言語と `PackageLocale: en-US` の不一致                                 |
|    — | 未分類（事務的クローズ含む）(`uncategorized`)                     |     296 (31.4%) |       53 (13.7%) |      243 (43.6%) | **`CLOSED` 243 件中 191 件は `Needs-CLA` (124) と `Duplicate` (67) の事務却下**    |

### 1.3 配布形式別の未マージ脱落率（`feedback` 943 件内訳）

| 配布形式          | `MERGED` | `CLOSED` | 未マージ脱落率 | 最頻出リスク                                                                  |
| ----------------- | -------: | -------: | -------------: | ----------------------------------------------------------------------------- |
| `portable`        |       30 |   **84** |      **73.7%** | DLL 欠損、Defender/未署名、CLI 挙動、`Scripted-Application`                   |
| `wix`             |       37 |   **66** |      **64.1%** | `Scope`・`ProductCode`/`UpgradeCode`・`UpgradeBehavior`                       |
| `zip`             |       77 |  **108** |      **58.4%** | `NestedInstallerType`/`RelativeFilePath`、DLL 欠損、ビルド来歴                |
| `exe`             |       30 |   **42** |      **58.3%** | `InstallerSwitches` 不備（`Validation-Unattended-Failed`）、`UpgradeBehavior` |
| `inno`            |       98 |  **131** |      **57.2%** | ARP 値不一致、`UpgradeBehavior: install`、VCRedist 依存                       |
| `nullsoft` (NSIS) |      110 |  **109** |      **49.8%** | `Publisher`/`DisplayVersion`/`ProductCode` 不一致、`UpgradeBehavior`          |

> **最重要示唆**: 差し戻しを受けた **`portable` PR の 73.7%**・**`wix` の 64.1%**・**`zip` の 58.4%** がマージに至らず `CLOSED` になっています。特に Portable / ZIP 系は「開発機では動くがクリーン VM で落ちる」罠を提出前に潰しておくことが決定的に重要です。

---

## 2. 配布形式 × アプリ種別 適用チェックマトリクス

自分のパッケージに該当する行・列のチェック ID をすべて通過させてから PR を作成してください。各 ID の検査区分（`[機械検査可]` / `[Sandbox検証]` / `[自己確認]`）は、Step 3 のプリフライト診断スクリプトおよび AI Skill 化とそのまま対応しています。

| 対象条件                                                                                                                                                          | 適用するチェック ID                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **全パッケージ共通（必須）**                                                                                                                                      | `CMN-01` 〜 `CMN-07` ＋ 提出前ストップ条件 `NG-01` 〜 `NG-04`                             |
| **配布形式: Portable / ポータブル内包 ZIP** (`portable`、または `zip` + `NestedInstallerType: portable`)                                                          | `PKG-PORT-01` 〜 `PKG-PORT-05`                                                            |
| **配布形式: インストーラー系（ZIP 内包インストーラー含む）** (`inno` / `nullsoft` / `wix` / `msi` / `exe`、および `zip` + 非 `portable` の `NestedInstallerType`) | `PKG-INST-01` 〜 `PKG-INST-06`（`zip` 配布時は `PKG-PORT-02` の内包パス・形式整合も併用） |
| **アプリ種別: CLI ツール**                                                                                                                                        | `APP-CLI-01` 〜 `APP-CLI-03`                                                              |
| **アプリ種別: GUI / GPU / WebView2 アプリ**                                                                                                                       | `APP-GUI-01` 〜 `APP-GUI-03`                                                              |
| **アプリ種別: 外部通信・AI・認証・課金あり**                                                                                                                      | `APP-NET-01` 〜 `APP-NET-03`                                                              |

---

## 3. 共通必須チェック（全パッケージ共通）

### `CMN-01` `[自己確認]` CLA 同意と重複 PR の禁止

- **根拠**: `CLOSED` コーパスで **`Needs-CLA` / `Stale CLA` が 124 件**（例: [#474352](https://github.com/microsoft/winget-pkgs/pull/474352), [#474182](https://github.com/microsoft/winget-pkgs/pull/474182)）、**`Resolution-Duplicate` が 67 件**（例: [#486146](https://github.com/microsoft/winget-pkgs/pull/486146), [#474368](https://github.com/microsoft/winget-pkgs/pull/474368)）。
- **対策**:
  - 初回提出直後に CLA Bot の案内が出たら、即座に `@microsoft-github-policy-service agree` を単独コメントする。
  - バージョン更新や修正時は**別 PR を作り直さず、既存 PR のブランチへ追加コミット**する（出し直しは重複クローズされ、キュー順位も振り出しに戻る）。

### `CMN-02` `[機械検査可]` 最新 `ManifestVersion` とスキーマヘッダの一致

- **根拠**: 非推奨 `ManifestVersion` 関連指摘 125 件（`MERGED` 33 / `CLOSED` 92）。旧版のまま滞留すると `Close with reason: Stale with ManifestVersion Deprecated;` で一括クローズされる（例: [#448664](https://github.com/microsoft/winget-pkgs/pull/448664), [#448445](https://github.com/microsoft/winget-pkgs/pull/448445), [#448272](https://github.com/microsoft/winget-pkgs/pull/448272)）。PR チェックボックスだけチェックして旧スキーマを出し直すと差し戻される（例: [#436234](https://github.com/microsoft/winget-pkgs/pull/436234)）。
- **対策**:
  - 提出時点の `microsoft/winget-pkgs` PR テンプレートが要求する現行最新 `ManifestVersion`（例: `1.12.0` 等、提出直前に最新の `manifests/` または `wingetcreate` で確認）と `# yaml-language-server: $schema=...` を全 YAML で完全一致させる。
  - `winget validate --manifest <dir>` を提出前にローカル実行してエラー 0 件にする。

### `CMN-03` `[機械検査可]` 不変・バージョン固定 `InstallerUrl` と `InstallerSha256` 一致

- **根拠**: URL 404・ハッシュ不一致 84 件（`MERGED` 42 / `CLOSED` 42。例: [#446873](https://github.com/microsoft/winget-pkgs/pull/446873), [#414628](https://github.com/microsoft/winget-pkgs/pull/414628), [#444016](https://github.com/microsoft/winget-pkgs/pull/444016), [#447522](https://github.com/microsoft/winget-pkgs/pull/447522)）。
- **対策**:
  - `releases/latest/download/...` のような**可変 URL は禁止**。必ずタグ固定（`releases/download/v1.2.3/...`）の不変 URL を使用する。
  - PR 待機中にリリース資産を差し替えたり削除したりしない（審査到達時に 404 や `Error-Hash-Mismatch` になると即差し戻し）。
  - `ReleaseNotesUrl` や `LicenseUrl` も HTTP 200 を返す実在 URL であることを確認する。

### `CMN-04` `[機械検査可]` `License` / `LicenseUrl` / `PackageUrl` / `Copyright` の整備

- **根拠**: `metadata-url` カテゴリ 200 件（21.2%。例: [#441771](https://github.com/microsoft/winget-pkgs/pull/441771), [#446873](https://github.com/microsoft/winget-pkgs/pull/446873)）。
- **対策**:
  - `License` を書いたら対応する `LicenseUrl`（リポジトリ内の `LICENSE` ファイルへの永続 URL）も必ず記載する。
  - `PackageUrl`・`PublisherUrl`・`Copyright`・`ShortDescription` を実態と一致させ、誇大宣伝や他社ブランド名の混入を避ける。

### `CMN-05` `[自己確認]` `PackageLocale` とアプリ実 UI 言語の一致

- **根拠**: `locale-language` カテゴリ 62 件（6.6%。例: [#446569](https://github.com/microsoft/winget-pkgs/pull/446569), [#445832](https://github.com/microsoft/winget-pkgs/pull/445832)）。
- **対策**:
  - 既定マニフェスト（`defaultLocale`）は通常 `en-US` で作成されるが、アプリ本体の UI が日本語・中国語・ポーランド語等のみの場合は、UI 言語に合わせた `PackageLocale`（例: `ja-JP`）にするか、英語 UI フォールバックを用意する。

### `CMN-06` `[機械検査可]` `Policy-Test-*` 誤検知ワードの事前回避と先回り説明

- **根拠**: `Policy-Test-*` 関連 124 件（`MERGED` 39 / `CLOSED` 85）、うち `Waived-Policy-Test-*` による誤検知解除 31 件（例: `Policy-Test-1.2` Targeted Brand [#453065](https://github.com/microsoft/winget-pkgs/pull/453065)・[#446381](https://github.com/microsoft/winget-pkgs/pull/446381)、`Policy-Test-2.7` Adult/Algo Speak [#448498](https://github.com/microsoft/winget-pkgs/pull/448498)、`Policy-Test-2.9` Profanity [#448248](https://github.com/microsoft/winget-pkgs/pull/448248)、命名却下 [#464837](https://github.com/microsoft/winget-pkgs/pull/464837)）。
- **対策**:
  - `PackageIdentifier` / `PackageName` / `ShortDescription` / `Description` / `Tags` に、無関係な大手ブランド名（例: `Microsoft`, `Adobe`, `Google`, `Apple` 等）や攻撃的・俗語的表現を含めない。
  - 技術用語（例: `PrtScr`、`agentbus`、`PDF` 等）が自動ポリシー検査に誤検知され得る場合は、PR 本文の「Policy-Test Notes」欄に無害な由来を先回り明記する。

### `CMN-07` `[自己確認]` コード署名状況・ビルド来歴・Defender 誤検知への備え

- **根拠**: 署名・Defender・VirusTotal 関連 181 件（`MERGED` 103 / `CLOSED` 78。例: [#450926](https://github.com/microsoft/winget-pkgs/pull/450926), [#460148](https://github.com/microsoft/winget-pkgs/pull/460148), [#442694](https://github.com/microsoft/winget-pkgs/pull/442694)）。
- **対策**:
  - 個人開発で未署名バイナリを出す場合でも、**公開リポジトリ + CI（GitHub Actions 等）でビルドされた公式リリース資産**であることを PR 本文に明記する（手元ビルドのブラックボックスバイナリより信頼性評価が明確に高い）。
  - 提出前に VirusTotal およびローカル Windows Defender でスキャンし、`Validation-Defender-Error` が出た場合は Microsoft Security Intelligence へ誤検知報告（Submit a file for malware analysis）を行う。

---

## 4. 配布形式別チェックリスト

### 4.1 Portable / ポータブル内包 ZIP 系（`portable` / `zip` + `NestedInstallerType: portable`）

> 差し戻し 299 件（`MERGED` 107 / `CLOSED` 192、`zip` 内包インストーラー含む集計）。`portable` 単独の未マージ脱落率は **73.7%** と全配布形式中で最悪。なお、ZIP 内に MSI / Inno 等のインストーラーを含む場合は `PKG-PORT-02` で `NestedInstallerType` を一致させた上で §4.2 のインストーラー系チェックを適用してください。

#### `PKG-PORT-01` `[機械検査可]` VC++ ランタイム（`VCRUNTIME140.dll` 等）の静的リンクまたは依存宣言

- **根拠**: DLL / ランタイム欠損カテゴリ 137 件（うち `portable`/`zip` 49 件）、`VCRUNTIME140` / `STATUS_DLL_NOT_FOUND`（`0xC0000135` / `-1073741515`）明示 34 件（例: 静的リンクで解消 [#434000](https://github.com/microsoft/winget-pkgs/pull/434000)、`Microsoft.VCRedist.2015+.x64` 追加で通過 [#442135](https://github.com/microsoft/winget-pkgs/pull/442135)、クリーン VM 起動失敗 [#442875](https://github.com/microsoft/winget-pkgs/pull/442875)・[#428137](https://github.com/microsoft/winget-pkgs/pull/428137)）。
- **対策（優先順）**:
  1. **最優先（推奨）**: C/C++・Rust（`+crt-static`）・Go（CGO なし）等で CRT を**静的リンク**し、外部 DLL 依存をゼロにする。
  2. 動的リンクが避けられない場合、`.installer.yaml` に以下を必ず宣言する:

     ```yaml
     Dependencies:
       PackageDependencies:
         - PackageIdentifier: Microsoft.VCRedist.2015+.x64
     ```
  3. ビルド成果物の PE Import Table を検査し、`VCRUNTIME140.dll` / `VCRUNTIME140_1.dll` / `MSVCP140.dll` / `libgcc_*.dll` / `libstdc++-6.dll` への未同梱依存がないことを確認する。

#### `PKG-PORT-02` `[機械検査可]` `NestedInstallerType`・`RelativeFilePath`・`PortableCommandAlias` の整合

- **根拠**: ポータブル展開・コマンドエイリアス指摘（例: [#460148](https://github.com/microsoft/winget-pkgs/pull/460148), [#445063](https://github.com/microsoft/winget-pkgs/pull/445063), [#464837](https://github.com/microsoft/winget-pkgs/pull/464837)）、および [WinGet 公式インストーラースキーマ（`NestedInstallerType`）](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/schema/1.28.0/installer.md#nestedinstallertype---nestedinstallertype-is-required-when-installertype-is-an-archive-type-such-as-zip)。
- **対策**:
  - `InstallerType: zip` の場合は、`NestedInstallerType` に**ZIP 内の実際の内包形式**を指定し、`NestedInstallerFiles[].RelativeFilePath` を ZIP 内の実パスと完全一致させる:
    - **ZIP 内がポータブル実行ファイルの場合**: `NestedInstallerType: portable` とし、`PortableCommandAlias` を指定する。
    - **ZIP 内がインストーラー（MSI / Inno / NSIS / WiX / EXE 等）の場合**: `NestedInstallerType` に実際の形式（`msi` / `inno` / `nullsoft` / `wix` / `exe` 等）を指定する。**この場合 `PortableCommandAlias` は使わず、§4.2（`PKG-INST-01` 〜 `PKG-INST-06`）のインストーラー系チェックを併せて適用する**（誤って `portable` を指定すると WinGet がインストーラーとして実行できない）。
  - ポータブル ZIP 内に複数の `.exe` が含まれる場合、エンドユーザーが実行すべきエントリポイントだけを登録し、複数コマンドを登録する意図があれば PR 本文で説明する。
  - `PortableCommandAlias`（`portable` 配布・`NestedInstallerType: portable` 時のみ）は他ツールや Windows 標準コマンドと衝突せず、不適切な語句を含まないプロフェッショナルな名称にする。

#### `PKG-PORT-03` `[Sandbox検証]` クリーン VM での同梱ファイル解決・起動確認

- **根拠**: PyInstaller / ラッパー起動失敗（例: [#441456](https://github.com/microsoft/winget-pkgs/pull/441456)）、展開先パス依存の失敗（例: [#442337](https://github.com/microsoft/winget-pkgs/pull/442337)）。
- **対策**:
  - [§7.1 Windows Sandbox クリーン環境での検証手順](#71-windows-sandbox-クリーン環境での検証手順)（公式 `Tools/SandboxTest.ps1`、または管理者権限で `LocalManifestFiles` を有効化した上での `winget install -m`）でインストールを実行し、WinGet が作成したシンボリックリンク（`%LOCALAPPDATA%\Microsoft\WinGet\Links\`）経由で**カレントディレクトリが別の場所（例: `C:\Users\WDAGUtilityAccount\Desktop`）からでも正常起動する**ことを確認する。

#### `PKG-PORT-04` `[自己確認]` ビルド来歴の透明性確保

- **根拠**: ビルド来歴・ミラー・非公式配布に関する確認 46 件（`MERGED` 21 / `CLOSED` 25。例: [#460148](https://github.com/microsoft/winget-pkgs/pull/460148), [#442694](https://github.com/microsoft/winget-pkgs/pull/442694)）。
- **対策**:
  - ソースコード公開先、ビルドワークフロー（GitHub Actions 等）、およびリリース同梱の `SHA256SUMS` / `checksums.txt` URL を PR 本文へ記載する。

#### `PKG-PORT-05` `[機械検査可]` 単一アーキテクチャ誤記防止（`x64` / `arm64` / `x86`）

- **対策**:
  - PE ヘッダの Machine フィールドと `.installer.yaml` の `Architecture` が完全一致していることを確認する。

---

### 4.2 インストーラー系（Inno / NSIS / WiX / MSI / EXE・ZIP 内包インストーラー含む）

> 差し戻し 653 件（Inno 229 / NSIS 219 / WiX・MSI・Burn 133 / カスタム EXE 72）。`InstallerType: zip` で `NestedInstallerType` が `inno` / `nullsoft` / `wix` / `msi` / `exe` 等のアーカイブ内包インストーラーも本節の対象です。最大の地雷は **ARP レジストリ不一致**・**`UpgradeBehavior` 欠落/誤設定**・**サイレント実行失敗**。

#### `PKG-INST-01` `[Sandbox検証]` ARP（アプリと機能 / レジストリ）値の完全一致

- **根拠**: ARP / レジストリ整合指摘 119 件（`MERGED` 73 / `CLOSED` 46。例: `Publisher` 不一致 [#450891](https://github.com/microsoft/winget-pkgs/pull/450891)、`DisplayVersion` 表記揺れ [#445940](https://github.com/microsoft/winget-pkgs/pull/445940)、`ProductCode` に表示名を誤記 [#438961](https://github.com/microsoft/winget-pkgs/pull/438961)、Inno `ProductCode` 欠落 [#446565](https://github.com/microsoft/winget-pkgs/pull/446565)）。
- **対策**:
  - [§7.1 Windows Sandbox クリーン環境での検証手順](#71-windows-sandbox-クリーン環境での検証手順)で実際にインストールした直後、レジストリの以下 3 パスから実測値を取得し、マニフェストと **1 文字単位で一致**させる:
    - `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`
    - `HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*`
    - `HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*`
  - 照合必須項目:
    - `AppsAndFeaturesEntries[].DisplayName`（または `PackageName`）
    - `AppsAndFeaturesEntries[].Publisher`（または `Publisher`）
    - `AppsAndFeaturesEntries[].DisplayVersion`（`PackageVersion` と表記が異なる場合は `DisplayVersion` を明示）
    - `ProductCode`（**表示名ではなくレジストリのキー名そのもの**。Inno なら `{GUID}_is1`、MSI/WiX なら `{GUID}`）
    - `AppsAndFeaturesEntries[].UpgradeCode`（MSI / WiX の場合）

#### `PKG-INST-02` `[機械検査可]` `UpgradeBehavior: uninstallPrevious` の適切な設定

- **根拠**: `UpgradeBehavior` 指摘（例: Inno [#445691](https://github.com/microsoft/winget-pkgs/pull/445691)、NSIS [#441771](https://github.com/microsoft/winget-pkgs/pull/441771)・[#438961](https://github.com/microsoft/winget-pkgs/pull/438961)、カスタム EXE [#442228](https://github.com/microsoft/winget-pkgs/pull/442228)、WiX/MSI の議論 [#466128](https://github.com/microsoft/winget-pkgs/pull/466128)）。
- **対策**:
  - **Inno / NSIS / カスタム EXE**: 上書きインストールで旧バージョンが ARP に二重残存しないよう、原則 `UpgradeBehavior: uninstallPrevious` を明示する（インストーラー自身が旧版を自動アンインストールする設計で動作確認済みの場合のみ `install` を選択し、PR 本文にその旨を記載）。
  - **WiX / MSI**: `<MajorUpgrade>` により同一 `UpgradeCode` の旧版をクリーンに置換する標準 MSI なら `install` で問題ない（`UpgradeCode` を `AppsAndFeaturesEntries` へ正確に記載する）。旧版が残存する構成の場合は `uninstallPrevious` を設定する。

#### `PKG-INST-03` `[Sandbox検証]` `Scope`（`user` / `machine`）と実際の書込先の一致

- **根拠**: `Scope` 不一致修正（例: WiX `scope: machine` 修正 [#445305](https://github.com/microsoft/winget-pkgs/pull/445305)）。
- **対策**:
  - 管理者権限を要求し `Program Files` / `HKLM` へ書き込む場合は `Scope: machine`、`%LOCALAPPDATA%` / `HKCU` へ書き込む場合は `Scope: user` を設定する。両方対応する場合はインストーラーエントリを 2 つに分けて `InstallerSwitches` を明示する。

#### `PKG-INST-04` `[Sandbox検証]` 完全サイレント（非対話）インストール・アンインストール

- **根拠**: `Validation-Unattended-Failed` 18 件、`Validation-Shell-Execute` 19 件（例: [#463296](https://github.com/microsoft/winget-pkgs/pull/463296), [#456090](https://github.com/microsoft/winget-pkgs/pull/456090)）。
- **対策**:
  - インストール完了後にアプリやブラウザを自動起動しない（検証 VM でプロセスが残ると検証がタイムアウトまたは失敗する）。
  - UAC・確認ダイアログ・ライセンス同意画面を出さず終了コード `0` で完結することを確認する。
  - カスタム `exe` の場合は `InstallerSwitches.Silent` と `InstallerSwitches.SilentWithProgress` を必ず指定し、`Interactive-Only-Installer` 扱いを回避する。

#### `PKG-INST-05` `[機械検査可]` ランタイム依存の同梱または `PackageDependencies` 宣言

- **根拠**: Inno/MSI でも VC++ ランタイム未同梱で起動失敗するケースが多数（例: [#446565](https://github.com/microsoft/winget-pkgs/pull/446565), [#442875](https://github.com/microsoft/winget-pkgs/pull/442875), [#434000](https://github.com/microsoft/winget-pkgs/pull/434000)）。
- **対策**:
  - インストーラーがランタイムを同梱・自動導入しない場合は、`PackageDependencies`（`Microsoft.VCRedist.2015+.x64`, `Microsoft.DotNet.DesktopRuntime.*`, `Microsoft.EdgeWebView2Runtime` 等）を明示する。

#### `PKG-INST-06` `[自己確認]` インストーラー形式別の固有ポイント早見表

| 形式         | `InstallerType` | 既定サイレント引数                         | 典型的な落とし穴                                                                                                                                                                         |
| ------------ | --------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inno Setup   | `inno`          | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART` | `ProductCode` の末尾 `_is1` 抜け、`UpgradeBehavior: install` で旧版残存、終了時自動起動                                                                                                  |
| NSIS         | `nullsoft`      | `/S`                                       | `ProductCode` に表示名を誤記（[#438961](https://github.com/microsoft/winget-pkgs/pull/438961)）、`Publisher` 表記揺れ（[#450891](https://github.com/microsoft/winget-pkgs/pull/450891)） |
| WiX / MSI    | `wix` / `msi`   | `/quiet /norestart`                        | `Scope` と `ALLUSERS` 不一致、`ProductCode`/`UpgradeCode` 欠落                                                                                                                           |
| カスタム EXE | `exe`           | **自動付与されない（必須指定）**           | `InstallerSwitches.Silent` 欠落による `Validation-Unattended-Failed`                                                                                                                     |

---

## 5. アプリ種別別チェックリスト

### 5.1 CLI ツール

#### `APP-CLI-01` `[Sandbox検証]` 引数なし実行時の終了コードと検証コマンド明示

- **根拠**: 起動・コマンド・終了コード関連指摘 134 件（`MERGED` 87 / `CLOSED` 47。例: [#446386](https://github.com/microsoft/winget-pkgs/pull/446386), [#439314](https://github.com/microsoft/winget-pkgs/pull/439314), [#445063](https://github.com/microsoft/winget-pkgs/pull/445063)）。
- **背景**: `winget-pkgs` の手動検証・自動検証では、インストール直後に**引数なしで実行ファイル（または `PortableCommandAlias`）を 1 回起動**して生存確認を行う。`clap` / `cobra` / `argparse` 等の一般的な CLI フレームワークは引数不足時に `exit code 2`（または `1`）を返すため、事前説明がないと「起動エラー（クラッシュ）」と誤認されやすい。
- **対策**:
  1. 可能な場合は、引数なし実行時に Usage / ヘルプを表示して `exit code 0` を返す設計にする。
  2. 仕様上 `exit code 1` または `2` を返す場合は、**PR 本文に「引数なし実行時は Usage を出力して終了コード 2 を返す正常仕様である」こと、および推奨検証コマンド（例: `<cmd> --version` / `<cmd> --help`）を先回り明記**する。

#### `APP-CLI-02` `[Sandbox検証]` 非対話環境でのハング回避

- **根拠**: 引数なし起動で対話メニュー入力待ちに入り自動検証が停止する事例（例: [#445196](https://github.com/microsoft/winget-pkgs/pull/445196)）。
- **対策**:
  - 標準入力が TTY でない・引数なしの場合に無限入力待ちにならないか確認し、対話型メニューが開く仕様なら PR 本文に検証コマンド（非対話の `--version` 等）を明記する。

#### `APP-CLI-03` `[機械検査可]` `Commands` / `PortableCommandAlias` の正確性

- **対策**:
  - インストーラーが PATH へコマンドを追加する場合は `.installer.yaml` に `Commands:` を、`InstallerType: portable` または `InstallerType: zip`（`NestedInstallerType: portable`）の場合は `PortableCommandAlias:` を正確に記載する。

---

### 5.2 GUI・GPU・WebView2 アプリ

#### `APP-GUI-01` `[Sandbox検証]` クリーン VM の OpenGL 1.1 / ハードウェア GPU 非搭載制約への対応

- **根拠**: OpenGL / GPU / クリーン VM 起動失敗 25 件（`MERGED` 12 / `CLOSED` 13。例: OpenGL 2.0+ 要求で検証 VM の OpenGL 1.1 環境にて exit code 1 → Direct3D 12 フォールバックで通過 [#444709](https://github.com/microsoft/winget-pkgs/pull/444709)・[#444703](https://github.com/microsoft/winget-pkgs/pull/444703)）。
- **対策**:
  - `winget-pkgs` の検証 VM は **Microsoft Basic Display Adapter（GPU なし・OpenGL 1.1 のみ）** で動作する。
  - OpenGL 2.0+ / Vulkan 専用アプリはそのままでは即終了するため、**Direct3D (WARP) / ANGLE / ソフトウェアレンダリングへのフォールバック**を実装するか、GPU 必須で起動できない場合はエラーメッセージを表示して終了する仕様と必要要件を PR 本文に明記する。

#### `APP-GUI-02` `[Sandbox検証]` 検証 VM 標準解像度でのウィンドウ表示・画面外描画防止

- **根拠**: ウィンドウが VM 画面より縦長・画面外にスポーンして操作不能になった事例（例: [#444631](https://github.com/microsoft/winget-pkgs/pull/444631), [#448294](https://github.com/microsoft/winget-pkgs/pull/448294)）。
- **対策**:
  - 初回起動時のウィンドウサイズを **1024×768 以下に収まるよう制限**し、起動位置もプライマリモニタのワークエリア内にクランプする。

#### `APP-GUI-03` `[Sandbox検証]` GUI フレームワークランタイム（WebView2 / .NET / VC++）確認

- **対策**:
  - Tauri / Electron / WinUI / WPF / Qt 等のアプリは、Windows Sandbox（追加ランタイム未導入状態）で初回起動まで完走することを確認し、不足ランタイムがあれば同梱するか `PackageDependencies` に宣言する。

---

### 5.3 外部通信・AI・クラウド・認証機能あり

#### `APP-NET-01` `[自己確認]` 外部データ送信・テレメトリ・認証・AI API 利用時の `PrivacyUrl` 必須化

- **根拠**: **`privacy-policy` カテゴリ 265 件（全体 2 位・`MERGED` では 40.7% で 1 位）**。デバイス外へデータ送信・クラウド同期・OAuth 認証・AI/LLM API 通信を行うのに `PrivacyUrl` がない PR は極めて高確率で差し戻される（例: [#450926](https://github.com/microsoft/winget-pkgs/pull/450926), [#440393](https://github.com/microsoft/winget-pkgs/pull/440393)）。
- **対策**:
  - 以下のいずれかに 1 つでも該当する場合は、**必ず公式のプライバシーポリシーページを公開し、`defaultLocale.yaml` に `PrivacyUrl` を記載**する:
    - アカウント作成・ログイン・OAuth 連携（GitHub / Google / Microsoft 等）
    - ユーザーデータのクラウド同期・バックアップ・リモート API 送信
    - AI / LLM プロバイダ（OpenAI / Anthropic / Gemini 等）へのプロンプト・ファイル送信
    - テレメトリ・クラッシュレポート・利用統計の自動送信
  - **完全にローカル完結（外部通信なし、またはユーザーが明示指定したエンドポイントのみ）の場合**も、PR 本文にその旨を先回り明記するとメンテナの質問往復を防げる。

#### `APP-NET-02` `[自己確認]` 有料ライセンス・サブスクリプション・インアプリ課金の明示

- **根拠**: 有料プラン・ライセンス記載不備の差し戻し（例: [#431405](https://github.com/microsoft/winget-pkgs/pull/431405)）。
- **対策**:
  - フリーミアム・試用版・有料ライセンスを伴う場合は `License` を `Proprietary` 等実態に合わせて設定し、課金体系が誤解されないよう `Description`・`PurchaseUrl`（該当時）を整備する。

#### `APP-NET-03` `[自己確認]` 高リスク領域（金融・広範 OAuth）の事前確認

- **根拠**: バンキング系（`Policy-Test-1.8` [#467675](https://github.com/microsoft/winget-pkgs/pull/467675)）、Gmail/Drive 等の広範 OAuth アクセス（[#440393](https://github.com/microsoft/winget-pkgs/pull/440393)）。
- **対策**:
  - 金融取引・認証情報管理・広範な個人データアクセスを行うアプリは審査が特に厳格なため、最小権限設計と詳細なプライバシーポリシー・来歴説明を提出前に揃える。

---

## 6. 構造的 NG 事例（`CLOSED` コーパスから抽出した提出前ストップ条件）

以下に該当する場合、マニフェストをいくら直しても **`microsoft/winget-pkgs` のポリシー上マージされない（即却下・`CLOSED`）** ため、提出前にアーキテクチャ・配布方針を見直す必要があります。

### `NG-01` `[自己確認]` `Scripted-Application`（スクリプト主体のアプリは受入不可）

- **根拠**: `CLOSED` 8 件・**`MERGED` 0 件（却下率 100%）**（例: [#441274](https://github.com/microsoft/winget-pkgs/pull/441274), [#436234](https://github.com/microsoft/winget-pkgs/pull/436234), [#434699](https://github.com/microsoft/winget-pkgs/pull/434699), [#434282](https://github.com/microsoft/winget-pkgs/pull/434282)）。
- **メンテナ見解（[#436234](https://github.com/microsoft/winget-pkgs/pull/436234) 実引用）**: _"Unfortunately, we're not currently accepting scripted applications. Were it ported to another language and compiled, it would pass this check."_
- **対策**: PowerShell (`.ps1`) / バッチ (`.bat` / `.cmd`) / シェルスクリプト主体のツール（MSI や Inno で包んだだけのものを含む）は提出せず、Go / Rust / C# (NativeAOT / コンパイル済み) / C++ 等のコンパイル言語へ移植してから提出する。

### `NG-02` `[自己確認]` `Policy-Test-1.5`・`Blocking-Issue`・有害/不適切名称

- **根拠**: `Policy-Test-1.5` (`CLOSED` 36 件・`MERGED` 0 件)、`Blocking-Issue` (`CLOSED` 11 件・`MERGED` 0 件。例: 名称に `Criminal` を含み Policy 2.3 / 2.8 抵触 [#444942](https://github.com/microsoft/winget-pkgs/pull/444942)、不適切語を含む識別子 [#464837](https://github.com/microsoft/winget-pkgs/pull/464837))。
- **対策**: [Windows Package Manager Policies](https://learn.microsoft.com/en-us/windows/package-manager/package/windows-package-manager-policies) に抵触する機能・名称・配布形態でないことを事前に確認する。一度ポリシー却下されたパッケージの単純再提出は繰り返さない。

### `NG-03` `[Sandbox検証]` 特定ハードウェア必須・検証 VM でインストール不能なパッケージ

- **根拠**: `Hardware` + `Blocking-Issue`（例: [#436487](https://github.com/microsoft/winget-pkgs/pull/436487)）、`Validation-Installation-Error`（6 件）。
- **対策**: 特定ベンダーの物理デバイスやドライバが無いとインストーラー自体がエラー終了するパッケージは、自動・手動検証を通過できない。

### `NG-04` `[自己確認]` 来歴不明バイナリ・非公式リパック・別ドメインホスト

- **根拠**: `Validation-Domain`（`CLOSED` 11 件、`MERGED` でも要理由説明 [#412167](https://github.com/microsoft/winget-pkgs/pull/412167)）。
- **対策**: `PublisherUrl` と異なるドメイン（CDN / Object Storage / 個人ストレージ等）から `InstallerUrl` を配信する場合は、公式サイトからその URL へリンクされている根拠を PR 本文に明記する。公式リリース外の非公式リパックは原則不可。

---

## 7. 提出前ワークフローと自動化マップ（Step 3 連携仕様）

以下の順で事前チェックを通すことで、実データ上の差し戻し要因の大半を提出前に機械的・再現可能に潰せます。

| フェーズ                                                | 対象チェック ID                                                                                                                           | 実施方法（Step 3 プリフライト診断スクリプト対応）                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. 静的マニフェスト・URL 検査** `[機械検査可]`        | `CMN-02`, `CMN-03`, `CMN-04`, `CMN-06`, `PKG-PORT-02`, `PKG-PORT-05`, `PKG-INST-02`, `APP-CLI-03`                                         | `winget validate`、現行 `ManifestVersion` 検査、HTTP HEAD/GET 到達性・SHA-256 照合、不変 URL パターン検査、`zip` 内実体に応じた `NestedInstallerType` 分岐検証（`portable` 時のみ `PortableCommandAlias` 検査、非 `portable` 時はインストーラー系ルール適用）、`LicenseUrl`/`PrivacyUrl`/`UpgradeBehavior` 検査、`Policy-Test` 誤検知語句スキャン |
| **2. PE バイナリ静的検査** `[機械検査可]`               | `PKG-PORT-01`, `PKG-PORT-05`, `PKG-INST-05`, `CMN-07`                                                                                     | PE ヘッダの Machine（`x64`/`arm64`/`x86`）照合、Import Table の `VCRUNTIME140.dll` / `MSVCP140.dll` 等未同梱 DLL 依存検出、Authenticode 署名有無確認                                                                                                                                                                                              |
| **3. Windows Sandbox クリーン VM 検証** `[Sandbox検証]` | `PKG-PORT-03`, `PKG-INST-01`, `PKG-INST-03`, `PKG-INST-04`, `APP-CLI-01`, `APP-CLI-02`, `APP-GUI-01`, `APP-GUI-02`, `APP-GUI-03`, `NG-03` | [§7.1 の手順](#71-windows-sandbox-クリーン環境での検証手順)（`Tools/SandboxTest.ps1` または `LocalManifestFiles` 有効化後の `winget install -m`）で導入 → レジストリ ARP 値抽出・マニフェスト突き合わせ → CLI 引数なし終了コード & `--version` 検証 → GUI 起動・解像度確認 → `winget uninstall` 残骸確認                                          |
| **4. 先回り PR 本文作成 & CLA** `[自己確認]`            | `CMN-01`, `CMN-05`, `CMN-07`, `PKG-PORT-04`, `APP-NET-01`〜`03`, `NG-01`, `NG-02`, `NG-04`                                                | [先回り PR 本文テンプレート](templates/winget-pkgs-pr-template.md) を記入して提出し、直後に `@microsoft-github-policy-service agree` をコメント                                                                                                                                                                                                   |

### 7.1 Windows Sandbox クリーン環境での検証手順

クリーンな Windows Sandbox では既定で `LocalManifestFiles` が無効になっており、そのまま `winget install -m <manifest-dir>` を実行すると拒否されます。[WinGet 公式検証手順（`Validation.md`）](https://github.com/microsoft/winget-pkgs/blob/master/doc/Validation.md)に従い、以下のいずれかで検証してください。

1. **公式スクリプトを使う方法（推奨）**: `microsoft/winget-pkgs` リポジトリ同梱の `Tools/SandboxTest.ps1` を使い、WinGet 導入とローカルマニフェスト有効化を自動セットアップした Sandbox 上で検証する。

   ```powershell
   .\Tools\SandboxTest.ps1 <manifest-dir>
   ```

2. **手動で Windows Sandbox を使う方法**: Sandbox 内で WinGet を利用可能にした上で、**管理者権限の PowerShell で `LocalManifestFiles` を有効化してから**ローカルマニフェストをインストールする。

   ```powershell
   # 管理者権限の PowerShell でローカルマニフェストを許可
   winget settings --enable LocalManifestFiles
   winget install --manifest <manifest-dir>
   ```
