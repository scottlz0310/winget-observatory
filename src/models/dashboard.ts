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

export interface PercentileStats {
  totalMedianDays?: number;
  totalP75Days?: number;
  turnMedianDays?: number;
  turnP75Days?: number;
  readyMedianDays?: number;
  readyP75Days?: number;
}

export interface DashboardCalculatedMetrics {
  latestDelta: DeltaMetrics;
  velocity: VelocityMetrics;
  calendarGap: CalendarGapMetrics;
  historyWithDeltas: HistoryRowWithDelta[];
}
