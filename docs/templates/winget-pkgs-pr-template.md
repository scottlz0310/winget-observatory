# `microsoft/winget-pkgs` 初回提出用 先回り PR 本文テンプレート

> **目的**: メンテナの初回レビュー時に発生しやすい質問往復（CLI の引数なし終了コード、外部通信・プライバシーポリシー、ビルド来歴・未署名、ARP 値、`Policy-Test-*` 誤検知など）を提出時点で先回り解消し、1 往復でのマージを狙うためのテンプレートです。
>
> **根拠**: [実践ガイド＆チェックリスト](../winget-pkgs-submission-guide.md)（90 日窓 3,603 件・差し戻し 943 件コーパス分析）。
> **使い方**: `microsoft/winget-pkgs` の PR テンプレート（標準チェックボックス）の末尾に、下記の「英語テンプレート本体」をそのまま追記してください（該当しない項目は削除または `N/A` と明記）。

---

## コピペ用テンプレート本体（英語・`microsoft/winget-pkgs` 貼付用）

```markdown
### Reviewer Notes (Pre-Submission Verification)

#### 1. Package Overview & Distribution

- **Official Repository / Homepage**: <https://github.com/OWNER/REPO>
- **Distribution Format**: `<portable | zip (portable) | inno | nullsoft | wix | msi | exe>`
- **Target Architecture(s)**: `<x64 / arm64 / x86>`
- **UI Language / Locale**: `<en-US / ja-JP / etc.>` (matches `PackageLocale` in manifest)

#### 2. Runtime & Verification Behavior

- **Clean VM / Windows Sandbox Test**: Verified install, launch, and uninstall on a clean Windows Sandbox environment (`winget install -m <manifest-dir>`).
- **CLI Invocation Behavior** _(for CLI tools; remove if GUI-only)_:
  - Running `<command>` without arguments prints usage/help and exits with code `<0 | 1 | 2>` _(by design — e.g., argument parser behavior)_.
  - Recommended non-interactive verification command: `<command> --version` / `<command> --help` (exits with code `0`).
- **GUI / Rendering Behavior** _(for GUI apps; remove if CLI-only)_:
  - Verified startup on a clean VM without hardware GPU (Microsoft Basic Display Adapter / software rendering fallback works without crashing).
  - Initial window fits within 1024×768 without spawning off-screen.
- **Runtime Dependencies**: `<Statically linked CRT (no external VCRUNTIME140.dll dependency) | Declared PackageDependencies: Microsoft.VCRedist.2015+.x64 | Bundled inside installer>`.
- **ARP / Registry Verification** _(for installers; remove if portable/zip)_:
  - `DisplayName`: `<exact value from Uninstall registry>`
  - `Publisher`: `<exact value from Uninstall registry>`
  - `DisplayVersion`: `<exact value from Uninstall registry>`
  - `ProductCode`: `<exact registry key name, e.g. {GUID}_is1 or {GUID}>`
  - `Scope`: `<user | machine>` (writes to `<HKCU | HKLM>`)
  - `UpgradeBehavior`: `<uninstallPrevious | install (MajorUpgrade verified)>`

#### 3. Network, Telemetry & Privacy

- **External Network Access**: `<None (fully offline local tool) | Connects only to user-configured endpoints | Connects to <service/API>>`
- **Telemetry / Analytics / Crash Reporting**: `<None | Opt-in only | Enabled (documented in PrivacyUrl)>`
- **Account / Authentication / OAuth**: `<None | Required (scopes: ...)>`
- **Privacy Policy**: `<Declared in PrivacyUrl: https://... | Not applicable (no data leaves the user's device)>`

#### 4. Build Provenance & Code Signing

- **Source & CI Build**: Built from public source via GitHub Actions workflow (`<https://github.com/OWNER/REPO/blob/vX.Y.Z/.github/workflows/release.yml>`).
- **Release Asset & Checksum**: Immutable version-tagged asset (`<https://github.com/OWNER/REPO/releases/tag/vX.Y.Z>`), SHA-256 matches published checksums (`<checksums URL or N/A>`).
- **Code Signing**: `<Signed with ... | Unsigned (independent OSS release; scanned clean with Windows Defender / VirusTotal)>`.

#### 5. Automated Policy / Validation Notes _(include only if applicable)_

- **Policy-Test False Positive Pre-Note** _(e.g. `Policy-Test-1.2` / `2.7` / `2.9`)_: `<Explain benign origin of flagged word/name if any, or remove this bullet.>`
- **Download Domain Note** _(if `InstallerUrl` host differs from `PublisherUrl`)_: `<Official download CDN/storage linked from homepage: https://...>`
```

---

## 提出直後のチェック（忘れやすい 3 点）

1. **CLA 同意を最速で完了する**: 初回提出直後に CLA Bot がコメントしたら、即座に `@microsoft-github-policy-service agree` を単独コメントする（`CLOSED` 事務却下の最多要因: 124 件）。
2. **PR 待機中にリリース資産を上書きしない**: 審査到達までタグ・ZIP・インストーラーの SHA-256 を絶対に書き換えない。
3. **修正時は別 PR を作らず同じブランチに push する**: 別 PR を出すと `Resolution-Duplicate` でクローズされ（67 件）、キュー順位が最後尾に戻る。

---

## 記入例

### 例 1: Portable / ZIP 配布の CLI ツール（Rust / Go 製・完全ローカル動作・未署名）

```markdown
### Reviewer Notes (Pre-Submission Verification)

#### 1. Package Overview & Distribution

- **Official Repository / Homepage**: https://github.com/example/mycli
- **Distribution Format**: `zip` (`NestedInstallerType: portable`, `PortableCommandAlias: mycli`)
- **Target Architecture(s)**: `x64`
- **UI Language / Locale**: `en-US` (matches `PackageLocale` in manifest)

#### 2. Runtime & Verification Behavior

- **Clean VM / Windows Sandbox Test**: Verified install, invocation from `Desktop`, and uninstall on a clean Windows Sandbox (`winget install -m .`).
- **CLI Invocation Behavior**:
  - Running `mycli` without arguments prints usage/help to stderr and exits with code `2` (standard `clap` argument-parser behavior, not a crash).
  - Recommended verification command: `mycli --version` or `mycli --help` (exits with code `0`).
- **Runtime Dependencies**: Statically linked CRT (`+crt-static`); verified no external `VCRUNTIME140.dll` / `MSVCP140.dll` dependency.

#### 3. Network, Telemetry & Privacy

- **External Network Access**: None (fully offline local file processor).
- **Telemetry / Analytics / Crash Reporting**: None.
- **Account / Authentication / OAuth**: None.
- **Privacy Policy**: Not applicable (no data leaves the user's device).

#### 4. Build Provenance & Code Signing

- **Source & CI Build**: Built from public source via GitHub Actions (`https://github.com/example/mycli/blob/v1.0.0/.github/workflows/release.yml`).
- **Release Asset & Checksum**: Immutable tag asset (`https://github.com/example/mycli/releases/tag/v1.0.0`); SHA-256 matches `SHA256SUMS.txt` attached to the release.
- **Code Signing**: Unsigned (independent OSS project; verified clean with Windows Defender and VirusTotal).
```

### 例 2: Inno Setup 配布の GUI アプリ（外部 AI API 通信あり・`Policy-Test` 誤検知対策あり）

```markdown
### Reviewer Notes (Pre-Submission Verification)

#### 1. Package Overview & Distribution

- **Official Repository / Homepage**: https://github.com/example/mygui
- **Distribution Format**: `inno`
- **Target Architecture(s)**: `x64`
- **UI Language / Locale**: `en-US` (English default UI; matches `PackageLocale`)

#### 2. Runtime & Verification Behavior

- **Clean VM / Windows Sandbox Test**: Verified silent install (`/VERYSILENT /SUPPRESSMSGBOXES /NORESTART`), GUI launch, and uninstall on a clean Windows Sandbox.
- **GUI / Rendering Behavior**:
  - Starts cleanly on Microsoft Basic Display Adapter (Direct3D WARP software fallback verified; does not require OpenGL 2.0+ hardware acceleration).
  - Initial window size is 960×640 and centered within the primary monitor work area.
- **Runtime Dependencies**: Declared `PackageDependencies: Microsoft.VCRedist.2015+.x64` (verified on a clean Sandbox without pre-installed VC++ Redistributable).
- **ARP / Registry Verification**:
  - `DisplayName`: `MyGUI`
  - `Publisher`: `Example Dev`
  - `DisplayVersion`: `1.2.0`
  - `ProductCode`: `{12345678-1234-1234-1234-1234567890AB}_is1`
  - `Scope`: `user` (writes to `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`)
  - `UpgradeBehavior`: `uninstallPrevious`

#### 3. Network, Telemetry & Privacy

- **External Network Access**: Connects to user-configured LLM API endpoints (OpenAI / Anthropic) only when invoked by the user, plus optional GitHub release update check.
- **Telemetry / Analytics / Crash Reporting**: None.
- **Account / Authentication / OAuth**: User provides their own API key (stored locally via Windows DPAPI).
- **Privacy Policy**: Declared in `PrivacyUrl`: `https://github.com/example/mygui/blob/main/PRIVACY.md`

#### 4. Build Provenance & Code Signing

- **Source & CI Build**: Built from public source via GitHub Actions (`https://github.com/example/mygui/blob/v1.2.0/.github/workflows/release.yml`).
- **Release Asset & Checksum**: Immutable tag asset (`https://github.com/example/mygui/releases/tag/v1.2.0`).
- **Code Signing**: Unsigned (independent OSS project; verified clean with Windows Defender).

#### 5. Automated Policy / Validation Notes

- **Policy-Test False Positive Pre-Note**: The description mentions `"PDF"` / `"Markdown"` purely as supported file formats; this application is not affiliated with Adobe or any third-party brand.
```
