/**
 * 作者別累計マージ数および PR 作者メタデータの GraphQL alias バッチクエリ生成・応答パース・チャンク実行を行う純粋関数群。
 * 外部 I/O クライアントへの直接依存を持たず、高階関数（executeGraphql）経由で実行する。
 */

/**
 * 複数の作者に対する GitHub GraphQL エイリアスクエリを構築する。
 * 各作者の winget-pkgs 全期間におけるマージ済み PR 累計件数を一括照会する。
 */
export function buildAuthorMergedCountQuery(repository: string, authors: string[]): string {
  if (authors.length === 0) {
    return "";
  }

  const aliasLines = authors.map((author, index) => {
    // author login に引用符などが混入しないよう英数字/ハイフンにサニタイズ（安全対策）
    const sanitizedAuthor = author.replace(/[^a-zA-Z0-9\-_]/g, "");
    return `  u_${index}: search(query: "repo:${repository} is:pr is:merged author:${sanitizedAuthor}", type: ISSUE, first: 1) { issueCount }`;
  });

  return `query {\n${aliasLines.join("\n")}\n}`;
}

/**
 * GraphQL エイリアス検索結果から、作者ごとの累計マージ件数マップを復元する。
 */
export function parseAuthorMergedCounts(
  authors: string[],
  data: Record<string, { issueCount?: number } | undefined>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < authors.length; i++) {
    const author = authors[i];
    const key = `u_${i}`;
    const issueCount = data[key]?.issueCount ?? 0;
    counts.set(author, issueCount);
  }
  return counts;
}

/** 生涯マージ件数バッチ照会の既定チャンクサイズ（Search alias 過負荷によるセカンダリレート制限抑制のため 15） */
export const DEFAULT_AUTHOR_MERGED_BATCH_SIZE = 15;

/** 作者メタデータ一括取得（alias クエリ）の既定チャンクサイズ */
export const DEFAULT_AUTHOR_METADATA_BATCH_SIZE = 50;

export interface PullRequestAuthorMetadata {
  author?: string;
  authorType?: string;
  authorAssociation?: string;
}

/**
 * 複数 PR の author（__typename, login）と authorAssociation を 1 クエリで取得する
 * GraphQL alias クエリを構築する。
 */
export function buildPullRequestAuthorMetadataQuery(
  repository: string,
  prNumbers: readonly number[],
): string {
  const slashIndex = repository.indexOf("/");
  if (slashIndex <= 0 || slashIndex === repository.length - 1 || prNumbers.length === 0) {
    return "";
  }
  const owner = repository.slice(0, slashIndex).replace(/[^a-zA-Z0-9\-_.]/g, "");
  const name = repository.slice(slashIndex + 1).replace(/[^a-zA-Z0-9\-_.]/g, "");
  if (!owner || !name) {
    return "";
  }

  const aliases = prNumbers.map((num, index) => {
    if (!Number.isInteger(num) || num <= 0) {
      throw new RangeError(`PR 番号は正の整数を指定してください: ${num}`);
    }
    return `    p_${index}: pullRequest(number: ${num}) {\n      author {\n        __typename\n        login\n      }\n      authorAssociation\n    }`;
  });

  return `query {\n  repository(owner: "${owner}", name: "${name}") {\n${aliases.join("\n")}\n  }\n}`;
}

export interface PullRequestAuthorMetadataQueryResponse {
  repository?: Record<
    string,
    | {
        author?: {
          __typename?: string | null;
          login?: string | null;
        } | null;
        authorAssociation?: string | null;
      }
    | null
    | undefined
  > | null;
}

/**
 * GraphQL alias 応答から PR 番号ごとの作者メタデータマップを復元する。
 * pullRequest ノードが null（未取得・存在しない等）の番号はマップに含めない。
 */
export function parsePullRequestAuthorMetadata(
  prNumbers: readonly number[],
  data: PullRequestAuthorMetadataQueryResponse | undefined,
): Map<number, PullRequestAuthorMetadata> {
  const result = new Map<number, PullRequestAuthorMetadata>();
  const repoNode = data?.repository;
  if (!repoNode) {
    return result;
  }

  for (let i = 0; i < prNumbers.length; i++) {
    const num = prNumbers[i];
    const prNode = repoNode[`p_${i}`];
    if (!prNode) continue;

    result.set(num, {
      ...(prNode.author?.login ? { author: String(prNode.author.login) } : {}),
      ...(prNode.author?.__typename ? { authorType: String(prNode.author.__typename) } : {}),
      ...(prNode.authorAssociation ? { authorAssociation: String(prNode.authorAssociation) } : {}),
    });
  }

  return result;
}

export type PullRequestAuthorMetadataQueryExecutor = (
  query: string,
) => Promise<PullRequestAuthorMetadataQueryResponse | undefined>;

export interface ResolvePullRequestAuthorMetadataOptions {
  /** 1 バッチあたりの最大 PR 数（既定: 50） */
  batchSize?: number;
}

/**
 * 指定された PR 番号群について、作者メタデータ（author / authorType / authorAssociation）を
 * チャンク分割の GraphQL alias クエリで一括解決する。
 */
export async function resolvePullRequestAuthorMetadata(
  repository: string,
  prNumbers: readonly number[],
  executeGraphql: PullRequestAuthorMetadataQueryExecutor,
  options: ResolvePullRequestAuthorMetadataOptions = {},
): Promise<Map<number, PullRequestAuthorMetadata>> {
  const result = new Map<number, PullRequestAuthorMetadata>();
  if (!repository) {
    return result;
  }

  const batchSize = options.batchSize ?? DEFAULT_AUTHOR_METADATA_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`batchSize は 1 以上の整数を指定してください: ${batchSize}`);
  }

  const uniqueNumbers = Array.from(new Set(prNumbers.filter((n) => Number.isInteger(n) && n > 0)));
  for (let i = 0; i < uniqueNumbers.length; i += batchSize) {
    const batch = uniqueNumbers.slice(i, i + batchSize);
    const query = buildPullRequestAuthorMetadataQuery(repository, batch);
    if (!query) continue;

    const data = await executeGraphql(query);
    const parsed = parsePullRequestAuthorMetadata(batch, data);
    for (const [num, meta] of parsed) {
      result.set(num, meta);
    }
  }

  return result;
}

export type AuthorMergedCountQueryExecutor = (
  query: string,
) => Promise<Record<string, { issueCount?: number } | undefined> | undefined>;

export interface ResolveAuthorMergedCountsOptions {
  /** 1 バッチあたりの最大作者数（既定: 25） */
  batchSize?: number;
  /** 既知のキャッシュマップ（指定時は未照会の作者のみ検索し、解決結果を追記する） */
  cache?: Map<string, number>;
}

/**
 * 作者 login 配列について、重複排除・キャッシュ確認のうえでチャンク分割し、
 * GraphQL エイリアスクエリで各作者の生涯マージ済み PR 総数を解決して Map<string, number> で返す。
 */
export async function resolveAuthorMergedCounts(
  repository: string,
  logins: readonly string[],
  executeGraphql: AuthorMergedCountQueryExecutor,
  options: ResolveAuthorMergedCountsOptions = {},
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!repository) {
    return result;
  }

  const batchSize = options.batchSize ?? DEFAULT_AUTHOR_MERGED_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(`batchSize は 1 以上の整数を指定してください: ${batchSize}`);
  }

  const cache = options.cache;
  const uniqueLogins = Array.from(new Set(logins.filter(Boolean)));
  const unknownLogins: string[] = [];

  for (const login of uniqueLogins) {
    if (cache?.has(login)) {
      result.set(login, cache.get(login) as number);
    } else {
      unknownLogins.push(login);
    }
  }

  for (let i = 0; i < unknownLogins.length; i += batchSize) {
    const batch = unknownLogins.slice(i, i + batchSize);
    const query = buildAuthorMergedCountQuery(repository, batch);
    if (!query) continue;

    const data = await executeGraphql(query);
    const counts = parseAuthorMergedCounts(batch, data ?? {});
    for (const [author, count] of counts) {
      result.set(author, count);
      cache?.set(author, count);
    }
  }

  return result;
}
