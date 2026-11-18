/**
 * マージ済みサンプルの初回提出者（First-Timer）判定に関する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義のみに依存する。
 */

/** 現在の初回・健康体判定ロジックのバージョン（1: コミット数制限あり旧版, 2: コミット数制限撤廃版, 3: Waived-* 免除ラベル健康体扱い版, 4: timeline-blocking 除外廃止・累計マージ実績統一版, 5: Validation-Guide 阻害ラベル化・ReadyAt 再計測版） */
export const CURRENT_FIRST_TIMER_VERSION = 5;

/** Waived-* 免除ラベルを健康体扱いとして no-ready を評価した最低バージョン */
export const MIN_WAIVED_READY_VERSION = 3;

/** Validation-Guide 阻害ラベル化を反映した ReadyAt / ReadyDays を持つ最低バージョン */
export const MIN_VALIDATION_GUIDE_READY_VERSION = 5;

/**
 * 検索一覧の軽量メタデータから、初回提出者の候補として詳細フェッチを行う価値があるか判定するための入力。
 * Draft 除外（`draft:false`）および阻害ラベル除外（`-label:...`）は GitHub Search クエリ側で実施済み。
 */
export interface CandidatePreFilterInput {
  author?: string;
}

/**
 * 候補一覧から作者ごとの出現頻度マップを集計する。
 */
export function countCandidateAuthors(candidates: Array<{ author?: string }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of candidates) {
    if (c.author) {
      counts.set(c.author, (counts.get(c.author) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 検索一覧の軽量メタデータから、初回提出者の候補として詳細フェッチを行う価値があるか判定する。
 *
 * Draft 除外・阻害ラベル除外は検索クエリ側で絞り込み済みのため、
 * 作者が判明しており同期間の全候補内で複数回出現している（常連）場合のみ false を返す。
 * コミット数は手直し（2〜7コミット）を含む初回提出者全体を対象とするため制限しない。
 *
 * @param candidate 検査対象の候補メタデータ
 * @param authorCounts 同期間の全候補における作者ごとの出現頻度マップ
 */
export function isCandidateEligibleForFirstTimerDetail(
  candidate: CandidatePreFilterInput,
  authorCounts: Map<string, number>,
): boolean {
  if (candidate.author && (authorCounts.get(candidate.author) ?? 0) > 1) {
    return false;
  }
  return true;
}

/**
 * サンプル一覧から「作者が判明しており、同一サンプル内で1件しか登場しない（単発）」
 * 候補作者 login の一意なリストを抽出する。
 */
export function extractSingleHitCandidateLogins(
  samples: Array<{ author?: string; commitCount?: number; isFirstTimer?: boolean }>,
): string[] {
  const authorCounts = new Map<string, number>();
  for (const s of samples) {
    if (s.author) {
      authorCounts.set(s.author, (authorCounts.get(s.author) ?? 0) + 1);
    }
  }

  const singleHitLogins = new Set<string>();
  for (const s of samples) {
    if (s.author && authorCounts.get(s.author) === 1) {
      // 既に isFirstTimer が確定（true/false 明確に判定済み）していない候補
      if (s.isFirstTimer === undefined) {
        singleHitLogins.add(s.author);
      }
    }
  }

  return Array.from(singleHitLogins);
}

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

/**
 * キャッシュ済みのサンプルが、判定ロジックの改定に伴い再評価（タイムライン・詳細の再取得）を必要とするか判定する純粋関数。
 *
 * - FirstTimerVersion >= CURRENT_FIRST_TIMER_VERSION (5) のエントリは最新ルールで計測済みのため再評価不要。
 * - Validation-Guide 阻害化（v5）より前の版（未設定または FirstTimerVersion < MIN_VALIDATION_GUIDE_READY_VERSION）では
 *   Validation-Guide 一時付与区間が非 Ready 扱いにならず ReadyAt / ReadyDays が誤って早い値で記録されている可能性があるため、
 *   すべての sample エントリをタイムラインごと再取得して再計測する。
 */
export function shouldReevaluateCachedSample(params: {
  isFirstTimer?: boolean;
  firstTimerReason?: string;
  firstTimerVersion?: number;
  commitCount: number;
  authorCountInCandidates: number;
  author?: string;
}): boolean {
  if (
    params.firstTimerVersion !== undefined &&
    params.firstTimerVersion >= CURRENT_FIRST_TIMER_VERSION
  ) {
    return false;
  }

  if (
    params.firstTimerVersion === undefined ||
    params.firstTimerVersion < MIN_VALIDATION_GUIDE_READY_VERSION
  ) {
    return true;
  }

  if (params.firstTimerReason === "timeline-blocking") {
    return true;
  }

  if (
    params.firstTimerReason === "lifetime-merged" ||
    params.firstTimerReason === "recurring-author"
  ) {
    return false;
  }

  // 旧版で IsFirstTimer: false と判定された複数コミットのサンプル
  if (params.isFirstTimer === false && params.commitCount > 1) {
    return params.authorCountInCandidates <= 1;
  }

  return false;
}

/**
 * タイムライン・詳細の再取得を行わず、保存済み Author を用いた初回提出者判定の再評価のみ行うべきか判定する純粋関数。
 * ReadyAt 再計測済みの MIN_VALIDATION_GUIDE_READY_VERSION 以上かつ CURRENT_FIRST_TIMER_VERSION 未満の
 * timeline-blocking エントリのみを対象とし、v5 未満は ReadyAt 再計測を伴うタイムライン再取得に委ねる。
 */
export function shouldReevaluateAuthorFirstTimer(params: {
  firstTimerReason?: string;
  firstTimerVersion?: number;
  author?: string;
}): boolean {
  if (
    params.firstTimerVersion === undefined ||
    params.firstTimerVersion < MIN_VALIDATION_GUIDE_READY_VERSION ||
    params.firstTimerVersion >= CURRENT_FIRST_TIMER_VERSION
  ) {
    return false;
  }
  return params.firstTimerReason === "timeline-blocking" && Boolean(params.author);
}

/**
 * キャッシュ済みのスキップ済み PR が、再評価（詳細取得）を必要とするか判定する純粋関数。
 * - Reason === "no-ready": 旧版（firstTimerVersion < MIN_WAIVED_READY_VERSION または未設定）では
 *   Waived-*-Error が残ったままマージされた PR が no-ready として保存されていた可能性があるため、予算内で再評価する。
 * - Reason === "not-first-timer-candidate": 全体集計窓内に入った場合、または初回詳細適格になった場合に再評価する。
 */
export function shouldReevaluateSkippedCandidate(params: {
  reason?: string;
  firstTimerVersion?: number;
  isWithinOverallWindow: boolean;
  isEligibleForDetail: boolean;
}): boolean {
  if (params.reason === "no-ready") {
    return (
      params.firstTimerVersion === undefined || params.firstTimerVersion < MIN_WAIVED_READY_VERSION
    );
  }
  if (params.reason !== undefined && params.reason !== "not-first-timer-candidate") {
    return false;
  }
  return params.isWithinOverallWindow || params.isEligibleForDetail;
}
