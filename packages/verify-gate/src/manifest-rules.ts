import type { GateFinding, ManifestBundle, ParsedManifestFile } from "./types";

export const DEFAULT_MIN_MANIFEST_VERSION = "1.10.0";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;
const MUTABLE_URL_PATTERN =
  /\/releases\/latest\/|\/latest\/download\/|[?&](?:version|tag)=latest\b|\/nightly\/|\/canary\//i;
const SCRIPT_EXTENSION_PATTERN = /\.(?:ps1|psm1|bat|cmd|vbs|wsf|sh)(?:$|[?#])/i;
const POLICY_BRAND_PATTERN =
  /\b(?:microsoft|windows\s+defender|adobe|google\s+chrome|apple|paypal|bank(?:ing)?)\b/i;
const POLICY_SENSITIVE_PATTERN = /\b(?:fuck|shit|criminal|crack|keygen|pirate|porn|nsfw)\b/i;
const NETWORK_PRIVACY_SIGNAL_PATTERN =
  /\b(?:telemetry|analytics|cloud\s+sync|oauth|sign[\s-]?in|login|account|openai|anthropic|gemini|claude|chatgpt|llm|ai\s+assistant|api\s+key)\b/i;

const INSTALLER_TYPES_REQUIRING_UPGRADE_BEHAVIOR = new Set(["inno", "nullsoft", "exe"]);
const NON_PORTABLE_NESTED_TYPES = new Set([
  "inno",
  "nullsoft",
  "wix",
  "msi",
  "exe",
  "burn",
  "msix",
]);

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getInstallerHostFile(bundle: ManifestBundle): ParsedManifestFile | null {
  return bundle.installerFile ?? bundle.singletonFile;
}

export function getLocaleHostFile(bundle: ManifestBundle): ParsedManifestFile | null {
  return bundle.defaultLocaleFile ?? bundle.singletonFile;
}

export interface IndexedInstallerEntry {
  index: number;
  entry: Record<string, unknown> | null;
}

export function getIndexedInstallerEntries(bundle: ManifestBundle): IndexedInstallerEntry[] {
  const host = getInstallerHostFile(bundle);
  if (!host || !Array.isArray(host.data.Installers)) {
    return [];
  }
  return host.data.Installers.map((raw, index) => ({
    index,
    entry: asRecord(raw),
  }));
}

export function getInstallerEntries(bundle: ManifestBundle): Record<string, unknown>[] {
  return getIndexedInstallerEntries(bundle)
    .map((item) => item.entry)
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

export function resolveEffectiveInstallerType(
  hostData: Record<string, unknown>,
  entry: Record<string, unknown>,
): {
  installerType: string | null;
  nestedInstallerType: string | null;
  effectiveType: string | null;
} {
  const installerType =
    (asString(entry.InstallerType) ?? asString(hostData.InstallerType))?.toLowerCase() ?? null;
  const nestedInstallerType =
    (
      asString(entry.NestedInstallerType) ?? asString(hostData.NestedInstallerType)
    )?.toLowerCase() ?? null;
  const effectiveType =
    installerType === "zip" && nestedInstallerType ? nestedInstallerType : installerType;
  return { installerType, nestedInstallerType, effectiveType };
}

function extractPackageDependenciesFromContainer(container: Record<string, unknown>): string[] {
  const depObj = asRecord(container.Dependencies);
  if (!depObj || !Array.isArray(depObj.PackageDependencies)) return [];
  const deps: string[] = [];
  for (const item of depObj.PackageDependencies) {
    const rec = asRecord(item);
    const id = rec ? asString(rec.PackageIdentifier) : null;
    if (id) deps.push(id);
  }
  return deps;
}

/**
 * 指定アーキテクチャに該当するインストーラーエントリごとの実効 PackageDependencies（トップレベル共通依存 ∪ エントリ固有依存）を返す。
 * 該当アーキテクチャのエントリが 0 件の場合は、他アーキテクチャのエントリ依存を流用せずトップレベル共通依存のみを 1 組として返す。
 */
export function resolveEffectivePackageDependencySetsForArchitecture(
  bundle: ManifestBundle,
  architecture: string,
): string[][] {
  const host = getInstallerHostFile(bundle);
  if (!host) return [];
  const topLevelDeps = extractPackageDependenciesFromContainer(host.data);
  const targetArch = architecture.toLowerCase();
  const matchingEntries = getInstallerEntries(bundle).filter(
    (entry) => asString(entry.Architecture)?.toLowerCase() === targetArch,
  );
  if (matchingEntries.length === 0) {
    return [topLevelDeps];
  }
  return matchingEntries.map((entry) => [
    ...new Set([...topLevelDeps, ...extractPackageDependenciesFromContainer(entry)]),
  ]);
}

export interface ManifestRuleOptions {
  minManifestVersion?: string;
}

export function evaluateManifestRules(
  bundle: ManifestBundle,
  options: ManifestRuleOptions = {},
): GateFinding[] {
  const findings: GateFinding[] = [];
  const minVersion = options.minManifestVersion ?? DEFAULT_MIN_MANIFEST_VERSION;

  // 1. 基本構成チェック
  if (
    !bundle.singletonFile &&
    (!bundle.versionFile || !bundle.installerFile || !bundle.defaultLocaleFile)
  ) {
    const missing: string[] = [];
    if (!bundle.versionFile) missing.push("version");
    if (!bundle.installerFile) missing.push("installer");
    if (!bundle.defaultLocaleFile) missing.push("defaultLocale");
    findings.push({
      id: "CMN-02-STRUCTURE",
      status: "fail",
      title: "必須マニフェストファイルの不足",
      detail: `マルチファイルマニフェストに必要な ManifestType が不足しています: ${missing.join(", ")}`,
      remediation:
        "version / installer / defaultLocale の 3 ファイル（または singleton マニフェスト）を同一ディレクトリに配置してください。",
      guideRef: "CMN-02",
    });
  }

  // 2. CMN-02: ManifestVersion / $schema 一致・非推奨チェック・PackageIdentifier/Version 統一
  const packageIds = new Set<string>();
  const packageVersions = new Set<string>();
  const manifestVersions = new Set<string>();
  let schemaIssues = 0;

  for (const file of bundle.files) {
    const pkgId = asString(file.data.PackageIdentifier);
    const pkgVer = asString(file.data.PackageVersion);
    const manVer = asString(file.data.ManifestVersion);
    if (pkgId) packageIds.add(pkgId);
    if (pkgVer) packageVersions.add(pkgVer);
    if (manVer) manifestVersions.add(manVer);

    if (!manVer) {
      schemaIssues++;
      findings.push({
        id: "CMN-02",
        status: "fail",
        title: "ManifestVersion が未設定",
        detail: `${file.fileName} に ManifestVersion が記載されていません。`,
        remediation: `最新の ManifestVersion（${minVersion} 以上）を設定してください。`,
        file: file.fileName,
        guideRef: "CMN-02",
      });
      continue;
    }

    if (compareSemver(manVer, minVersion) < 0) {
      schemaIssues++;
      findings.push({
        id: "CMN-02",
        status: "fail",
        title: "非推奨・旧版の ManifestVersion を使用",
        detail: `${file.fileName} の ManifestVersion (${manVer}) が推奨下限 (${minVersion}) より古いです。`,
        remediation:
          "現行最新の ManifestVersion（例: 1.12.0 等、提出時点の PR テンプレート準拠）へ更新してください。",
        file: file.fileName,
        guideRef: "CMN-02",
      });
    }

    if (!file.schemaUrl) {
      schemaIssues++;
      findings.push({
        id: "CMN-02",
        status: "warn",
        title: "yaml-language-server の $schema ヘッダが欠落",
        detail: `${file.fileName} の先頭に # yaml-language-server: $schema=... ヘッダがありません。`,
        remediation: `ManifestVersion (${manVer}) に対応する公式 $schema ヘッダを先頭行へ追加してください。`,
        file: file.fileName,
        guideRef: "CMN-02",
      });
    } else if (file.schemaVersion && file.schemaVersion !== manVer) {
      schemaIssues++;
      findings.push({
        id: "CMN-02",
        status: "fail",
        title: "$schema バージョンと ManifestVersion の不一致",
        detail: `${file.fileName} で $schema (${file.schemaVersion}) と ManifestVersion (${manVer}) が一致していません。`,
        remediation: "$schema URL のバージョン番号と ManifestVersion を一致させてください。",
        file: file.fileName,
        guideRef: "CMN-02",
      });
    }
  }

  if (packageIds.size > 1 || packageVersions.size > 1 || manifestVersions.size > 1) {
    schemaIssues++;
    findings.push({
      id: "CMN-02",
      status: "fail",
      title: "マニフェストファイル間で識別子・バージョンが不一致",
      detail: `PackageIdentifier=[${[...packageIds].join(", ")}], PackageVersion=[${[...packageVersions].join(", ")}], ManifestVersion=[${[...manifestVersions].join(", ")}]`,
      remediation:
        "全マニフェスト YAML で PackageIdentifier / PackageVersion / ManifestVersion を一致させてください。",
      guideRef: "CMN-02",
    });
  }

  if (schemaIssues === 0) {
    findings.push({
      id: "CMN-02",
      status: "pass",
      title: "ManifestVersion と $schema ヘッダが整合",
      detail: `全 ${bundle.files.length} ファイルが ManifestVersion ${[...manifestVersions].join(", ")} で整合しています。`,
      guideRef: "CMN-02",
    });
  }

  // 3. Installer ルール (CMN-03, PKG-PORT-02, PKG-INST-02, APP-CLI-03, NG-01)
  const installerHost = getInstallerHostFile(bundle);
  const indexedInstallers = getIndexedInstallerEntries(bundle);
  if (installerHost) {
    if (indexedInstallers.length === 0) {
      findings.push({
        id: "CMN-03",
        status: "fail",
        title: "Installers エントリが空",
        detail: `${installerHost.fileName} に有効な Installers エントリがありません。`,
        remediation: "少なくとも 1 件のインストーラーエントリを定義してください。",
        file: installerHost.fileName,
        guideRef: "CMN-03",
      });
    }

    let validInstallerCount = 0;
    let urlAndHashIssues = 0;
    let zipAndCommandIssues = 0;
    let upgradeIssues = 0;
    let scriptIssues = 0;

    for (const { index, entry } of indexedInstallers) {
      const label = `Installers[${index}]`;
      if (!entry) {
        urlAndHashIssues++;
        findings.push({
          id: "CMN-03",
          status: "fail",
          title: `${label} がオブジェクトではない`,
          detail: `${installerHost.fileName} の ${label} がマッピングオブジェクトではありません（null やスカラー値等が混在しています）。`,
          remediation:
            "Installers 配列の各要素は Architecture / InstallerUrl / InstallerSha256 等を持つマッピングオブジェクトで記述してください。",
          file: installerHost.fileName,
          guideRef: "CMN-03",
        });
        continue;
      }

      validInstallerCount++;
      const url = asString(entry.InstallerUrl);
      const sha = asString(entry.InstallerSha256);
      const { installerType, nestedInstallerType, effectiveType } = resolveEffectiveInstallerType(
        installerHost.data,
        entry,
      );

      if (!url) {
        urlAndHashIssues++;
        findings.push({
          id: "CMN-03",
          status: "fail",
          title: `${label} の InstallerUrl が未設定`,
          detail: `${installerHost.fileName} の ${label} に InstallerUrl がありません。`,
          remediation: "タグ固定の HTTPS ダウンロード URL を設定してください。",
          file: installerHost.fileName,
          guideRef: "CMN-03",
        });
      } else {
        if (!url.toLowerCase().startsWith("https://")) {
          urlAndHashIssues++;
          findings.push({
            id: "CMN-03",
            status: "fail",
            title: `${label} の InstallerUrl が HTTPS ではない`,
            detail: `InstallerUrl="${url}" は HTTPS ではありません。`,
            remediation: "HTTPS の不変ダウンロード URL を使用してください。",
            file: installerHost.fileName,
            guideRef: "CMN-03",
          });
        }
        if (MUTABLE_URL_PATTERN.test(url)) {
          urlAndHashIssues++;
          findings.push({
            id: "CMN-03",
            status: "fail",
            title: `${label} に可変 URL（latest 等）を使用`,
            detail: `InstallerUrl="${url}" はリリース差し替えでハッシュ不一致を起こす可変 URL です。`,
            remediation:
              "バージョンタグ固定（例: /releases/download/v1.2.3/...）の不変 URL に変更してください。",
            file: installerHost.fileName,
            guideRef: "CMN-03",
          });
        }
        if (SCRIPT_EXTENSION_PATTERN.test(url)) {
          scriptIssues++;
          findings.push({
            id: "NG-01",
            status: "fail",
            title: `${label} がスクリプト拡張子を直接参照`,
            detail: `InstallerUrl="${url}" は Scripted-Application として即却下される拡張子です。`,
            remediation:
              "PowerShell / Batch 等スクリプト主体アプリは受入不可のため、コンパイル済みバイナリへ移行してください。",
            file: installerHost.fileName,
            guideRef: "NG-01",
          });
        }
      }

      if (!sha || !SHA256_HEX_PATTERN.test(sha)) {
        urlAndHashIssues++;
        findings.push({
          id: "CMN-03",
          status: "fail",
          title: `${label} の InstallerSha256 が不正`,
          detail: `InstallerSha256="${sha ?? ""}" は 64 桁の 16 進数 SHA-256 ではありません。`,
          remediation: "配布ファイル実体の SHA-256（64 桁 16 進数）を設定してください。",
          file: installerHost.fileName,
          guideRef: "CMN-03",
        });
      }

      // PKG-PORT-02 / APP-CLI-03: portable 単体 vs zip(portable) vs zip(installer)
      const nestedFilesRaw = Array.isArray(entry.NestedInstallerFiles)
        ? entry.NestedInstallerFiles
        : Array.isArray(installerHost.data.NestedInstallerFiles)
          ? installerHost.data.NestedInstallerFiles
          : [];
      const indexedNestedFiles = nestedFilesRaw.map((item, nfIdx) => ({
        nfIdx,
        item: asRecord(item),
      }));

      if (installerType === "portable") {
        if (
          indexedNestedFiles.length > 0 ||
          asString(entry.PortableCommandAlias) ||
          asString(installerHost.data.PortableCommandAlias)
        ) {
          zipAndCommandIssues++;
          findings.push({
            id: "APP-CLI-03",
            status: "fail",
            title: `${label}（単体 portable EXE）で ZIP 用フィールドを使用`,
            detail:
              "InstallerType: portable の単体 EXE では NestedInstallerFiles / PortableCommandAlias ではなく Commands の先頭要素がコマンド名として参照されます。",
            remediation:
              "PortableCommandAlias / NestedInstallerFiles を外し、コマンド名指定には Commands を使用してください。",
            file: installerHost.fileName,
            guideRef: "APP-CLI-03",
          });
        }
      } else if (installerType === "zip") {
        if (!nestedInstallerType) {
          zipAndCommandIssues++;
          findings.push({
            id: "PKG-PORT-02",
            status: "fail",
            title: `${label}（zip）に NestedInstallerType が未設定`,
            detail:
              "InstallerType: zip では ZIP 内の実際の形式（portable / inno / msi 等）の宣言が必須です。",
            remediation: "ZIP 内包ファイルに合わせて NestedInstallerType を設定してください。",
            file: installerHost.fileName,
            guideRef: "PKG-PORT-02",
          });
        }
        if (indexedNestedFiles.length === 0) {
          zipAndCommandIssues++;
          findings.push({
            id: "PKG-PORT-02",
            status: "fail",
            title: `${label}（zip）に NestedInstallerFiles が未設定`,
            detail:
              "InstallerType: zip では NestedInstallerFiles[].RelativeFilePath の指定が必須です。",
            remediation:
              "ZIP 内の実行ファイルまたはインストーラーへの RelativeFilePath を指定してください。",
            file: installerHost.fileName,
            guideRef: "PKG-PORT-02",
          });
        } else {
          for (const { nfIdx, item: nf } of indexedNestedFiles) {
            if (!nf) {
              zipAndCommandIssues++;
              findings.push({
                id: "PKG-PORT-02",
                status: "fail",
                title: `${label} NestedInstallerFiles[${nfIdx}] がオブジェクトではない`,
                detail: `${installerHost.fileName} の ${label} NestedInstallerFiles[${nfIdx}] がマッピングオブジェクトではありません。`,
                remediation:
                  "NestedInstallerFiles 配列の各要素は RelativeFilePath を持つマッピングオブジェクトで記述してください。",
                file: installerHost.fileName,
                guideRef: "PKG-PORT-02",
              });
              continue;
            }
            const relPath = asString(nf.RelativeFilePath);
            const alias = asString(nf.PortableCommandAlias);
            if (
              !relPath ||
              relPath.includes("..") ||
              relPath.startsWith("/") ||
              relPath.startsWith("\\")
            ) {
              zipAndCommandIssues++;
              findings.push({
                id: "PKG-PORT-02",
                status: "fail",
                title: `${label} NestedInstallerFiles[${nfIdx}] の RelativeFilePath が不正`,
                detail: `RelativeFilePath="${relPath ?? ""}" が空または不正なパスです。`,
                remediation: "ZIP 内の相対パス（例: app/mycli.exe）を正確に設定してください。",
                file: installerHost.fileName,
                guideRef: "PKG-PORT-02",
              });
            } else if (SCRIPT_EXTENSION_PATTERN.test(relPath)) {
              scriptIssues++;
              findings.push({
                id: "NG-01",
                status: "fail",
                title: `${label} NestedInstallerFiles[${nfIdx}] がスクリプト拡張子を参照`,
                detail: `RelativeFilePath="${relPath}" は Scripted-Application として却下対象です。`,
                remediation: "コンパイル済みバイナリ（.exe / インストーラー）を格納してください。",
                file: installerHost.fileName,
                guideRef: "NG-01",
              });
            }

            if (nestedInstallerType === "portable" && !alias) {
              zipAndCommandIssues++;
              findings.push({
                id: "APP-CLI-03",
                status: "warn",
                title: `${label} NestedInstallerFiles[${nfIdx}] に PortableCommandAlias が未設定`,
                detail:
                  "ポータブル ZIP では PortableCommandAlias を明示するとコマンド名と検証手順が明確になります。",
                remediation:
                  "NestedInstallerFiles[].PortableCommandAlias にコマンド名を設定してください。",
                file: installerHost.fileName,
                guideRef: "APP-CLI-03",
              });
            }
            if (
              nestedInstallerType &&
              NON_PORTABLE_NESTED_TYPES.has(nestedInstallerType) &&
              alias
            ) {
              zipAndCommandIssues++;
              findings.push({
                id: "PKG-PORT-02",
                status: "fail",
                title: `${label}（非 portable 内包 ZIP）に PortableCommandAlias が設定されている`,
                detail: `NestedInstallerType: ${nestedInstallerType} のインストーラー内包 ZIP では PortableCommandAlias は使用できません。`,
                remediation:
                  "PortableCommandAlias を削除し、インストーラー系チェック（ARP・UpgradeBehavior 等）を適用してください。",
                file: installerHost.fileName,
                guideRef: "PKG-PORT-02",
              });
            }
          }
        }
      }

      // PKG-INST-02 / PKG-INST-04: UpgradeBehavior & exe Silent switches
      if (effectiveType && INSTALLER_TYPES_REQUIRING_UPGRADE_BEHAVIOR.has(effectiveType)) {
        const upgradeBehavior = (
          asString(entry.UpgradeBehavior) ?? asString(installerHost.data.UpgradeBehavior)
        )?.toLowerCase();
        if (upgradeBehavior !== "uninstallprevious") {
          upgradeIssues++;
          findings.push({
            id: "PKG-INST-02",
            status: "warn",
            title: `${label}（${effectiveType}）の UpgradeBehavior が uninstallPrevious ではない`,
            detail: `現在値: ${upgradeBehavior ?? "(未設定)"}。旧版が ARP に二重残存し差し戻される頻出要因です。`,
            remediation:
              "UpgradeBehavior: uninstallPrevious を設定してください（インストーラー側で自動置換を検証済みの場合は PR 本文へ明記）。",
            file: installerHost.fileName,
            guideRef: "PKG-INST-02",
          });
        }
      }

      if (effectiveType === "exe") {
        const switches =
          asRecord(entry.InstallerSwitches) ?? asRecord(installerHost.data.InstallerSwitches);
        const silent = switches ? asString(switches.Silent) : null;
        if (!silent) {
          upgradeIssues++;
          findings.push({
            id: "PKG-INST-04",
            status: "fail",
            title: `${label}（カスタム exe）に InstallerSwitches.Silent が未設定`,
            detail:
              "InstallerType: exe では既定サイレント引数が自動付与されず、Validation-Unattended-Failed になります。",
            remediation:
              "InstallerSwitches.Silent（および SilentWithProgress）を必ず指定してください。",
            file: installerHost.fileName,
            guideRef: "PKG-INST-04",
          });
        }
      }
    }

    if (indexedInstallers.length > 0 && urlAndHashIssues === 0) {
      findings.push({
        id: "CMN-03",
        status: "pass",
        title: "InstallerUrl と InstallerSha256 の静的検証を通過",
        detail: `全 ${indexedInstallers.length} エントリが HTTPS 不変 URL かつ 64 桁 SHA-256 形式です。`,
        file: installerHost.fileName,
        guideRef: "CMN-03",
      });
    }
    if (validInstallerCount > 0 && zipAndCommandIssues === 0) {
      findings.push({
        id: "PKG-PORT-02",
        status: "pass",
        title: "配布形式・ZIP 内包形式・コマンドエイリアス定義が整合",
        detail: `${validInstallerCount} エントリの形式分岐とエイリアス指定に矛盾はありません。`,
        file: installerHost.fileName,
        guideRef: "PKG-PORT-02",
      });
    }
    if (validInstallerCount > 0 && upgradeIssues === 0) {
      findings.push({
        id: "PKG-INST-02",
        status: "pass",
        title: "UpgradeBehavior・サイレント引数の静的検証を通過",
        detail:
          "インストーラー種別に応じた UpgradeBehavior / Silent 引数が適切に設定されています。",
        file: installerHost.fileName,
        guideRef: "PKG-INST-02",
      });
    }
    if (validInstallerCount > 0 && scriptIssues === 0) {
      findings.push({
        id: "NG-01",
        status: "pass",
        title: "Scripted-Application 拡張子なし",
        detail: "URL / RelativeFilePath にスクリプト直参照は検出されませんでした。",
        file: installerHost.fileName,
        guideRef: "NG-01",
      });
    }
  }

  // 4. Locale メタデータルール (CMN-04, CMN-06, APP-NET-01)
  const localeHost = getLocaleHostFile(bundle);
  if (localeHost) {
    const license = asString(localeHost.data.License);
    const licenseUrl = asString(localeHost.data.LicenseUrl);
    const packageUrl = asString(localeHost.data.PackageUrl);
    const publisherUrl = asString(localeHost.data.PublisherUrl);
    const privacyUrl = asString(localeHost.data.PrivacyUrl);

    let metadataIssues = 0;
    if (!license) {
      metadataIssues++;
      findings.push({
        id: "CMN-04",
        status: "fail",
        title: "License が未設定",
        detail: `${localeHost.fileName} に License がありません。`,
        remediation: "SPDX 識別子（MIT / Apache-2.0 等）または Proprietary を記載してください。",
        file: localeHost.fileName,
        guideRef: "CMN-04",
      });
    } else if (!licenseUrl) {
      metadataIssues++;
      findings.push({
        id: "CMN-04",
        status: "warn",
        title: "LicenseUrl が未設定",
        detail: `License="${license}" に対応する LicenseUrl が未設定です（差し戻し頻出項目）。`,
        remediation:
          "リポジトリの LICENSE ファイルまたは公式ライセンスページへの永続 HTTPS URL を設定してください。",
        file: localeHost.fileName,
        guideRef: "CMN-04",
      });
    }

    for (const [field, value] of [
      ["PackageUrl", packageUrl],
      ["PublisherUrl", publisherUrl],
      ["LicenseUrl", licenseUrl],
      ["PrivacyUrl", privacyUrl],
    ] as const) {
      if (value && !value.toLowerCase().startsWith("https://")) {
        metadataIssues++;
        findings.push({
          id: "CMN-04",
          status: "warn",
          title: `${field} が HTTPS ではない`,
          detail: `${field}="${value}" は HTTPS ではありません。`,
          remediation: `${field} を HTTPS URL に更新してください。`,
          file: localeHost.fileName,
          guideRef: "CMN-04",
        });
      }
    }

    if (metadataIssues === 0) {
      findings.push({
        id: "CMN-04",
        status: "pass",
        title: "ライセンス・公式 URL メタデータが整備済み",
        detail: `License="${license}" / LicenseUrl 設定済み。`,
        file: localeHost.fileName,
        guideRef: "CMN-04",
      });
    }

    // CMN-06: Policy-Test 誤検知ワードスキャン
    const textFields = [
      asString(localeHost.data.PackageIdentifier),
      asString(localeHost.data.PackageName),
      asString(localeHost.data.ShortDescription),
      asString(localeHost.data.Description),
      ...asStringArray(localeHost.data.Tags),
    ].filter((v): v is string => v !== null);
    const joinedMeta = textFields.join(" ");

    const policyHits: string[] = [];
    const sensitiveMatch = POLICY_SENSITIVE_PATTERN.exec(joinedMeta);
    if (sensitiveMatch) policyHits.push(`不適切語候補: "${sensitiveMatch[0]}"`);
    const brandMatch = POLICY_BRAND_PATTERN.exec(joinedMeta);
    if (brandMatch) policyHits.push(`ブランド/金融語候補: "${brandMatch[0]}"`);

    if (policyHits.length > 0) {
      findings.push({
        id: "CMN-06",
        status: "warn",
        title: "Policy-Test 自動検知に反応し得る語句を検出",
        detail: `${localeHost.fileName} のメタデータから次を検出しました: ${policyHits.join(" / ")}`,
        remediation:
          "無関係なブランド名・不適切語は削除し、正当な技術用語の場合は先回り PR 本文テンプレートの Policy-Test Notes へ由来を明記してください。",
        file: localeHost.fileName,
        guideRef: "CMN-06",
      });
    } else {
      findings.push({
        id: "CMN-06",
        status: "pass",
        title: "Policy-Test 誤検知しやすい語句は未検出",
        detail: "メタデータ内に典型的なブランド/不適切語パターンは見つかりませんでした。",
        file: localeHost.fileName,
        guideRef: "CMN-06",
      });
    }

    // APP-NET-01: 外部通信・AI・認証シグナル検出時の PrivacyUrl チェック
    const netMatch = NETWORK_PRIVACY_SIGNAL_PATTERN.exec(joinedMeta);
    if (netMatch && !privacyUrl) {
      findings.push({
        id: "APP-NET-01",
        status: "warn",
        title: "外部通信・AI・認証の示唆があるが PrivacyUrl が未設定",
        detail: `説明文に "${netMatch[0]}" が含まれますが、PrivacyUrl が未設定です（差し戻し 2 位の頻出要因）。`,
        remediation:
          "外部送信・認証・AI API 通信を行う場合は PrivacyUrl を設定し、ローカル完結の場合は PR 本文にオフライン動作である旨を明記してください。",
        file: localeHost.fileName,
        guideRef: "APP-NET-01",
      });
    } else {
      findings.push({
        id: "APP-NET-01",
        status: "pass",
        title: "PrivacyUrl 要件チェックを通過",
        detail: privacyUrl
          ? `PrivacyUrl="${privacyUrl}" が設定されています。`
          : "メタデータ上に外部通信・認証の示唆は検出されませんでした（通信がある場合は PrivacyUrl を明記してください）。",
        file: localeHost.fileName,
        guideRef: "APP-NET-01",
      });
    }
  }

  return findings;
}
