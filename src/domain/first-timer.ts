/**
 * マージ済みサンプルの初回提出者（First-Timer）判定に関する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義のみに依存する。
 */

import { isBlockedLabel } from "./labels";

/** 現在の初回・健康体判定ロジックのバージョン（1: コミット数制限あり旧版, 2: コミット数制限撤廃版, 3: Waived-* 免除ラベル健康体扱い版） */
export const CURRENT_FIRST_TIMER_VERSION = 3;

export interface TimelineEventLike {
  event: string;
  created_at?: string;
  label?: { name: string };
}

/**
 * タイムライン履歴および Draft 状態を検査し、阻害要因（阻害ラベル付与・Draft化・Draft公開復帰）が
 * 過去に一度でも発生した履歴があるか判定する。
 * 一度でも阻害や Draft 状態（最初から Draft、途中で Draft 化）が発生した PR は、
 * 途中で解除・公開されたとしても「初期健康体」とはみなさない。
 */
export function hasBlockingOrDraftHistory(
  timeline: TimelineEventLike[],
  isDraft?: boolean,
): boolean {
  if (isDraft) return true;
  for (const ev of timeline) {
    if (
      ev.event === "converted_to_draft" ||
      ev.event === "convert_to_draft" ||
      ev.event === "ready_for_review"
    ) {
      return true;
    }
    if (ev.event === "labeled" && ev.label?.name) {
      if (isBlockedLabel(ev.label.name)) {
        return true;
      }
    }
  }
  return false;
}

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
 * サンプルが初回提出者（初期健康体）の前提条件を満たすか判定する。
 * コミット数は手直しを含む初回提出者全体を対象とするため制限しない。
 */
export function isFirstTimerSampleCandidate(sample: {
  commitCount?: number;
  timeline?: TimelineEventLike[];
  isDraft?: boolean;
}): boolean {
  if (sample.isDraft) {
    return false;
  }
  if (sample.timeline && hasBlockingOrDraftHistory(sample.timeline, sample.isDraft)) {
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

/** 生涯マージ件数バッチ照会の既定チャンクサイズ */
export const DEFAULT_AUTHOR_MERGED_BATCH_SIZE = 25;

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
 * キャッシュ済みのサンプルが、判定ロジックの改定（v2: コミット数制限撤廃 / v3: Waived-* 免除ラベルの健康体扱い）に伴い
 * 再評価（タイムライン・詳細の再取得）を必要とするか判定する純粋関数。
 *
 * - FirstTimerVersion >= CURRENT_FIRST_TIMER_VERSION (3) のエントリは最新ルールで計測済みのため再評価不要。
 * - 旧版（FirstTimerVersion < 3 または未設定）で FirstTimerReason: "timeline-blocking" のエントリは、
 *   `Waived-*-Error` 等の免除ラベルにより阻害扱いになっていた、または ReadyAt が後ろ倒しされていた可能性があるため再評価する。
 * - 旧版で FirstTimerReason が未設定かつ IsFirstTimer: false の複数コミット（commitCount > 1）サンプルも、
 *   単発 author（authorCountInCandidates <= 1）であれば再評価する。
 * - 一方、累計マージ数が2件以上と確定している場合（FirstTimerReason: "lifetime-merged"）や
 *   走査期間内に別 PR が存在する常連（FirstTimerReason: "recurring-author" または authorCountInCandidates > 1）で
 *   阻害ラベル履歴（timeline-blocking）を伴わないものは再評価不要。
 */
export function shouldReevaluateCachedSample(params: {
  isFirstTimer?: boolean;
  firstTimerReason?: string;
  firstTimerVersion?: number;
  commitCount: number;
  authorCountInCandidates: number;
}): boolean {
  if (
    params.firstTimerVersion !== undefined &&
    params.firstTimerVersion >= CURRENT_FIRST_TIMER_VERSION
  ) {
    return false;
  }

  // 旧版の timeline-blocking は Waived-*-Error 等の免除ラベル由来で阻害判定・ReadyAt 変動していた可能性があるため再評価
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
 * キャッシュ済みのスキップ済み PR が、再評価（詳細取得）を必要とするか判定する純粋関数。
 * - Reason === "no-ready": 旧版（firstTimerVersion < 3 または未設定）では Waived-*-Error が残ったままマージされた PR が
 *   no-ready として保存されていた可能性があるため、予算内で再評価する。
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
      params.firstTimerVersion === undefined ||
      params.firstTimerVersion < CURRENT_FIRST_TIMER_VERSION
    );
  }
  if (params.reason !== undefined && params.reason !== "not-first-timer-candidate") {
    return false;
  }
  return params.isWithinOverallWindow || params.isEligibleForDetail;
}
