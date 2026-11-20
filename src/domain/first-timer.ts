/**
 * マージ済みサンプルの初回提出者（First-Timer）判定に関する純粋関数群。
 * 外部 I/O を行わず、src/models の型定義のみに依存する。
 */

export type {
  AuthorMergedCountQueryExecutor,
  PullRequestAuthorMetadata,
  PullRequestAuthorMetadataQueryExecutor,
  PullRequestAuthorMetadataQueryResponse,
  ResolveAuthorMergedCountsOptions,
  ResolvePullRequestAuthorMetadataOptions,
} from "./first-timer-graphql";
export {
  buildAuthorMergedCountQuery,
  buildPullRequestAuthorMetadataQuery,
  DEFAULT_AUTHOR_MERGED_BATCH_SIZE,
  DEFAULT_AUTHOR_METADATA_BATCH_SIZE,
  parseAuthorMergedCounts,
  parsePullRequestAuthorMetadata,
  resolveAuthorMergedCounts,
  resolvePullRequestAuthorMetadata,
} from "./first-timer-graphql";

/** 現在の初回・健康体判定ロジックのバージョン（1: コミット数制限あり旧版, 2: コミット数制限撤廃版, 3: Waived-* 免除ラベル健康体扱い版, 4: timeline-blocking 除外廃止・累計マージ実績統一版, 5: Validation-Guide 阻害ラベル化・ReadyAt 再計測版, 6: 特権ロール・Bot 除外版, 7: 未捕捉阻害ラベル補強・Publisher-Verified 除外版） */
export const CURRENT_FIRST_TIMER_VERSION = 7;

/** Waived-* 免除ラベルを健康体扱いとして no-ready を評価した最低バージョン */
export const MIN_WAIVED_READY_VERSION = 3;

/** 現行の阻害ラベル・高速枠除外定義を反映した ReadyAt / 健全性基準の最低バージョン */
export const MIN_VALID_READY_VERSION = 7;

/**
 * 判定バージョンが、タイムライン・ReadyAt 再計測不要な最低基準を満たしているか判定する。
 */
export function hasValidatedReadyVersion(
  version: number | undefined,
  minReadyVersion: number = MIN_VALID_READY_VERSION,
): boolean {
  return version !== undefined && version >= minReadyVersion;
}

export const PRIVILEGED_AUTHOR_ASSOCIATIONS: ReadonlySet<string> = new Set([
  "MEMBER",
  "OWNER",
  "COLLABORATOR",
]);

/**
 * `authorAssociation` がリポジトリの特権ロール（MEMBER / OWNER / COLLABORATOR）に該当するか判定する。
 */
export function isPrivilegedAuthorAssociation(authorAssociation?: string | null): boolean {
  if (!authorAssociation) {
    return false;
  }
  return PRIVILEGED_AUTHOR_ASSOCIATIONS.has(authorAssociation.trim().toUpperCase());
}

/**
 * 作者がリポジトリの特権ロール（MEMBER / OWNER / COLLABORATOR）または Bot アカウントか判定する。
 * GitHub 仕様上、マージ後は一般の初回提出者も `CONTRIBUTOR` へ変わるため `CONTRIBUTOR` は許容する。
 */
export function isPrivilegedOrBotAuthor(params: {
  author?: string;
  authorType?: string;
  authorAssociation?: string;
}): boolean {
  if (params.authorType?.trim().toLowerCase() === "bot") {
    return true;
  }
  if (params.author?.trim().toLowerCase().endsWith("[bot]")) {
    return true;
  }
  return isPrivilegedAuthorAssociation(params.authorAssociation);
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
 * キャッシュ済みのサンプルが、判定ロジックの改定に伴い再評価（タイムライン・詳細の再取得）を必要とするか判定する純粋関数。
 *
 * - FirstTimerVersion >= CURRENT_FIRST_TIMER_VERSION (7) のエントリは最新ルールで計測済みのため再評価不要。
 * - Ready 判定改定（v7）より前の版（未設定または FirstTimerVersion < MIN_VALID_READY_VERSION）では
 *   新規阻害ラベル（Needs-Attention 等）の付与区間が非 Ready 扱いにならず ReadyAt / ReadyDays が誤って早い値で記録されている可能性があるため、
 *   すべての sample エントリをタイムラインごと再取得して再計測する。
 */
export function shouldReevaluateCachedSample(params: {
  isFirstTimer?: boolean;
  firstTimerReason?: string;
  firstTimerVersion?: number;
  commitCount: number;
  authorCountInCandidates: number;
  author?: string;
  minReadyVersion?: number;
  currentVersion?: number;
}): boolean {
  const currentVersion = params.currentVersion ?? CURRENT_FIRST_TIMER_VERSION;
  const minReadyVersion = params.minReadyVersion ?? MIN_VALID_READY_VERSION;

  if (params.firstTimerVersion !== undefined && params.firstTimerVersion >= currentVersion) {
    return false;
  }

  if (params.firstTimerVersion === undefined || params.firstTimerVersion < minReadyVersion) {
    return true;
  }

  if (params.firstTimerReason === "timeline-blocking") {
    return true;
  }

  if (
    params.firstTimerReason === "lifetime-merged" ||
    params.firstTimerReason === "recurring-author" ||
    params.firstTimerReason === "privileged-or-bot"
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
 * ReadyAt 再計測済みの MIN_VALID_READY_VERSION 以上かつ CURRENT_FIRST_TIMER_VERSION 未満の
 * timeline-blocking エントリのみを対象とし、MIN_VALID_READY_VERSION 未満はタイムライン再取得に委ねる。
 */
export function shouldReevaluateAuthorFirstTimer(params: {
  firstTimerReason?: string;
  firstTimerVersion?: number;
  author?: string;
}): boolean {
  if (
    params.firstTimerVersion === undefined ||
    params.firstTimerVersion < MIN_VALID_READY_VERSION ||
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
