// GitHub Pages ダッシュボード描画モジュール共通の型定義

import type { DepthsSnapshot } from "../../src/models/depths";
import type { FirstTimerFrontierSample, StaleFrontierSample } from "../../src/models/forecast";
import type { ForecastHistoryLine } from "../../src/models/forecast-history";
import type { ProgressHistoryRow, ProgressSnapshot } from "../../src/models/progress";

export interface BuildOptions {
  dataDir: string;
  outputDir: string;
}

/** スナップショットは部分的なファイルも許容して描画する（欠けた値は「-」表示） */
export type LatestProgress = Partial<ProgressSnapshot>;
export type LatestDepths = Partial<DepthsSnapshot>;

export interface DeltaBadge {
  text: string;
  className: string;
  label: string;
}

export interface DashboardRenderInput {
  progress: LatestProgress | null;
  depths: LatestDepths | null;
  csvRows: ProgressHistoryRow[];
  frontierSamples?: StaleFrontierSample[];
  forecastHistory?: ForecastHistoryLine[];
  firstTimerFrontierSamples?: FirstTimerFrontierSample[];
}
