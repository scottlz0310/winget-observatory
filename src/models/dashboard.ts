// ダッシュボード表示およびメトリクス計算に関する型定義

export interface HistoryRecord {
  timestamp: string;
  timestampMs: number;
  targetPr: number;
  frontNumber: number;
  frontCreatedAt?: string;
  activeAhead: number;
  totalAhead: number;
  behind: number;
  waitDays: number;
  /** 基準 PR の起票以降にマージされた、起票が基準 PR より前の PR の累積件数。記録が無い旧い行は null / 省略 */
  mergedOlder?: number | null;
  /** 同じ条件で、未マージのままクローズされた PR の累積件数 */
  closedOlder?: number | null;
}

export interface DeltaMetrics {
  activeAheadDelta: number | null;
  frontNumberDelta: number | null;
  behindDelta: number | null;
  waitDaysDelta: number | null;
}

export interface HistoryRowWithDelta {
  timestamp: string;
  targetPr: number;
  frontNumber: number;
  frontCreatedAt?: string;
  activeAhead: number;
  activeAheadDelta: number | null;
  totalAhead: number;
  behind: number;
  waitDays: number;
}

export interface VelocityMetrics {
  velocityPerDay: number | null;
  velocityPerHour: number | null;
  etaDays: number | null;
  etaDateJst: string | null;
  sampleHours: number;
  consumedCount: number;
}

export interface CalendarGapMetrics {
  gapDays: number | null;
  frontCreatedAt: string | null;
  targetCreatedAt: string | null;
}

export interface DashboardCalculatedMetrics {
  latestDelta: DeltaMetrics;
  velocity: VelocityMetrics;
  calendarGap: CalendarGapMetrics;
  historyWithDeltas: HistoryRowWithDelta[];
}
