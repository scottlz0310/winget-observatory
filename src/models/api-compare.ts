/**
 * REST と GraphQL API の応答比較・整合性検証に関するデータモデル型定義
 */

export interface FieldDiff {
  field: string;
  rest: unknown;
  graphql: unknown;
}

export interface SearchItemComparison {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels?: Array<{ name: string }>;
  is_draft?: boolean;
  pull_request?: {
    merged_at?: string | null;
  };
}

export interface SearchResultComparison {
  totalCount: number;
  items: SearchItemComparison[];
}

export interface SearchDiffResult {
  totalCountMatch: boolean;
  restTotalCount: number;
  graphqlTotalCount: number;
  countDiff: number;
  itemCountMatch: boolean;
  restNumbers: number[];
  graphqlNumbers: number[];
  missingInGraphql: number[];
  missingInRest: number[];
  orderMatch: boolean;
  fieldDiffs: Array<{
    number: number;
    diffs: FieldDiff[];
  }>;
}

export interface PrDetailDiffResult {
  match: boolean;
  diffs: FieldDiff[];
}

export interface TimelineDiffResult {
  countMatch: boolean;
  restEventCount: number;
  graphqlEventCount: number;
  eventSequenceMatch: boolean;
  blockingHistoryMatch: boolean;
  restHasBlocking: boolean;
  graphqlHasBlocking: boolean;
  readySinceMatch: boolean;
  restReadySince: string | null;
  graphqlReadySince: string | null;
  diffs: FieldDiff[];
}
