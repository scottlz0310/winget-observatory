/**
 * サマリー生成（summary）に関するデータモデル・型定義。
 */

import type { DepthsSnapshot } from "./depths";
import type { ProgressHistoryRow, ProgressSnapshot } from "./progress";

export interface GenerateSummaryOptions {
  dataDir?: string;
  outputPath?: string;
  targetPr?: number;
  repository?: string;
}

export interface SummaryDataInputs {
  progress: ProgressSnapshot | null;
  depths: DepthsSnapshot | null;
  historyRecords: ProgressHistoryRow[];
}
