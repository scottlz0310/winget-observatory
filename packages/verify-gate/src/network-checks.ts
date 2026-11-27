import { createHash } from "node:crypto";
import { getInstallerEntries, getInstallerHostFile, getLocaleHostFile } from "./manifest-rules";
import type { FetchLike, GateFinding, ManifestBundle } from "./types";

export interface NetworkCheckOptions {
  offline?: boolean;
  verifySha256?: boolean;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function probeUrl(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; finalUrl: string; error?: string }> {
  const tryRequest = async (method: "HEAD" | "GET") => {
    const response = await fetchImpl(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (method === "GET") {
      // 本文は読み切らずキャンセルして帯域消費を抑える
      await response.body?.cancel();
    }
    return response;
  };

  try {
    let response = await tryRequest("HEAD");
    if (response.status === 405 || response.status === 501) {
      response = await tryRequest("GET");
    }
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: response.url || url,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function downloadAndHashSha256(
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; sha256?: string; bytes?: number; error?: string }> {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    const hash = createHash("sha256");
    let bytes = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        const buf = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        hash.update(buf);
        bytes += buf.byteLength;
      }
    } else {
      const ab = await response.arrayBuffer();
      const buf = new Uint8Array(ab);
      hash.update(buf);
      bytes = buf.byteLength;
    }
    return { ok: true, status: response.status, sha256: hash.digest("hex").toUpperCase(), bytes };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runNetworkChecks(
  bundle: ManifestBundle,
  options: NetworkCheckOptions = {},
): Promise<GateFinding[]> {
  if (options.offline) {
    return [
      {
        id: "CMN-03-NET",
        status: "skip",
        title: "URL 到達性・SHA-256 ネットワーク検証をスキップ（--offline）",
        detail: "オフラインモードのため HTTP 到達性確認をスキップしました。",
        remediation:
          "提出前に --offline を外して URL 到達性（および必要に応じて --verify-sha256）を確認してください。",
        guideRef: "CMN-03",
      },
    ];
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const findings: GateFinding[] = [];

  // 1. InstallerUrl 到達性 & 任意 SHA-256 照合
  const installerHost = getInstallerHostFile(bundle);
  const installers = getInstallerEntries(bundle);
  for (const [index, entry] of installers.entries()) {
    const url = asString(entry.InstallerUrl);
    if (!url?.toLowerCase().startsWith("https://")) continue;

    if (options.verifySha256) {
      const expectedSha = asString(entry.InstallerSha256)?.toUpperCase();
      const res = await downloadAndHashSha256(url, fetchImpl, timeoutMs);
      if (!res.ok || !res.sha256) {
        findings.push({
          id: "CMN-03-SHA256",
          status: "fail",
          title: `Installers[${index}] のダウンロード・SHA-256 検証に失敗`,
          detail: `URL="${url}" (${res.error ?? `HTTP ${res.status}`})`,
          remediation:
            "URL が公開状態で HTTP 200 を返し、資産が取得可能であることを確認してください。",
          file: installerHost?.fileName,
          guideRef: "CMN-03",
        });
      } else if (expectedSha && res.sha256 !== expectedSha) {
        findings.push({
          id: "CMN-03-SHA256",
          status: "fail",
          title: `Installers[${index}] の InstallerSha256 が実体と不一致`,
          detail: `マニフェスト=${expectedSha} / 実測=${res.sha256} (${res.bytes} bytes)`,
          remediation: `InstallerSha256 を ${res.sha256} へ更新してください。`,
          file: installerHost?.fileName,
          guideRef: "CMN-03",
        });
      } else {
        findings.push({
          id: "CMN-03-SHA256",
          status: "pass",
          title: `Installers[${index}] の到達性と SHA-256 が一致`,
          detail: `HTTP ${res.status} / SHA-256=${res.sha256} (${res.bytes} bytes)`,
          file: installerHost?.fileName,
          guideRef: "CMN-03",
        });
      }
    } else {
      const probe = await probeUrl(url, fetchImpl, timeoutMs);
      if (!probe.ok) {
        findings.push({
          id: "CMN-03-NET",
          status: "fail",
          title: `Installers[${index}] の InstallerUrl が到達不能`,
          detail: `URL="${url}" (${probe.error ?? `HTTP ${probe.status}`})`,
          remediation: "InstallerUrl が認証なしで HTTP 200 を返すことを確認してください。",
          file: installerHost?.fileName,
          guideRef: "CMN-03",
        });
      } else {
        findings.push({
          id: "CMN-03-NET",
          status: "pass",
          title: `Installers[${index}] の InstallerUrl 到達確認済み`,
          detail: `HTTP ${probe.status} (${probe.finalUrl})`,
          file: installerHost?.fileName,
          guideRef: "CMN-03",
        });
      }
    }
  }

  // 2. メタデータ URL（PackageUrl / PublisherUrl / LicenseUrl / PrivacyUrl / ReleaseNotesUrl）
  const localeHost = getLocaleHostFile(bundle);
  if (localeHost) {
    const metaFields = [
      "PackageUrl",
      "PublisherUrl",
      "LicenseUrl",
      "PrivacyUrl",
      "ReleaseNotesUrl",
    ] as const;
    const seenUrls = new Set<string>();
    for (const field of metaFields) {
      const url = asString(localeHost.data[field]);
      if (!url?.toLowerCase().startsWith("https://") || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const probe = await probeUrl(url, fetchImpl, timeoutMs);
      if (!probe.ok) {
        findings.push({
          id: "CMN-04-NET",
          status: "fail",
          title: `${field} が到達不能`,
          detail: `${field}="${url}" (${probe.error ?? `HTTP ${probe.status}`})`,
          remediation: `${field} が HTTP 200 を返す公開ページを指しているか確認してください。`,
          file: localeHost.fileName,
          guideRef: "CMN-04",
        });
      }
    }
  }

  return findings;
}
