import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";
import type { GitHubApiClient } from "../src/api/github";
import { runExploreDepths } from "../src/cli/explore-depths";
import { CURRENT_DEPTHS_VERSION } from "../src/domain/depths";
import { calculateProgressStats, createProgressSnapshot } from "../src/domain/progress";

describe("buildDashboard", () => {
  test("データからダッシュボード HTML とコピーされたデータファイルを生成し、Velocity・ETA・Δ・パーセンタイル統計を出力する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-test-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");

    mkdirSync(dataDir, { recursive: true });

    // テスト用ダミーデータ作成（パーセンタイル統計を含む）
    const dummyProgress = {
      TimestampJst: "2026-11-07 12:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 123456,
      PrTitle: "Test package",
      FrontNumber: 120000,
      FrontCreatedAt: "2026-10-01 10:00",
      ActiveAhead: 100,
      TotalAhead: 150,
      Behind: 50,
      WaitDays: 5.5,
      TotalMedianDays: 30.5,
      TotalP75Days: 45.0,
      TurnMedianDays: 4.2,
      TurnP75Days: 6.8,
      ReadyMedianDays: 2.5,
      ReadyP75Days: 5.0,
      FirstTimerMedianDays: 37.5,
      FirstTimerP75Days: 39.0,
      FirstTimerSampleCount: 5,
      Comparison: {
        LaterCreated: 10,
        EarlierCreated: 20,
        LaterReady: 5,
        NewerNumber: 10,
        OlderNumber: 20,
        Verdict: "overtaken",
        FirstTimerLaterCreated: 1,
        RepeatOrExpressLaterCreated: 9,
      },
    };
    writeFileSync(join(dataDir, "latest-progress.json"), JSON.stringify(dummyProgress), "utf-8");

    const dummyDepths = {
      TimestampJst: "2026-11-07 12:00:00",
      TargetPr: {
        Number: 123456,
        Title: "Test package",
        CreatedAtJst: "2026-10-25 10:00", // 前線 2026-10-01 との差: 24 日
      },
      HealthyBottom: [
        {
          Number: 110000,
          Title: "Deepest PR",
          Url: "https://github.com/microsoft/winget-pkgs/pull/110000",
        },
      ],
      StaleBottom: [
        {
          Number: 449320,
          Title: "Stale package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/449320",
          作成日時: "2026-10-09 13:39",
          更新日時: "2026-10-09 14:54",
        },
      ],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(dummyDepths), "utf-8");

    // 24 時間で 50 件消化（150 -> 100）の時系列推移
    const dummyCsv = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis"
"2026-11-06 12:00:00","123456","119950","2026-09-30 10:00","150","200","40","4.5","4.5","4.5","1","updated"
"2026-11-07 12:00:00","123456","120000","2026-10-01 10:00","100","150","50","5.5","5.5","5.5","1","updated"
`;
    writeFileSync(join(dataDir, "progress-history.csv"), dummyCsv, "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      expect(existsSync(htmlPath)).toBe(true);

      const html = readFileSync(htmlPath, "utf-8");

      // 基本情報
      expect(html).toContain("123456");
      expect(html).toContain("Test package");
      expect(html).toContain("120000");
      expect(html).toContain("110000");
      expect(html).toContain("Deepest PR");
      expect(html).toContain("Winget Observatory Dashboard");

      // 新指標: 前回比 Δ バッジ
      expect(html).toContain("delta-badge delta-progress");
      expect(html).toContain("-50"); // 待ち件数減少（進行）
      // 待ち件数の推移・底の遅れ統合チャート
      expect(html).toContain('aria-label="待ち件数と底の遅れの推移（統合時系列チャート）"');
      expect(html.match(/<polyline /g)?.length).toBeGreaterThanOrEqual(2);
      expect(html).toContain("+50"); // 前線番号増加（進行）

      // ファーストビューのサマリー
      expect(html).toContain("🎯 初回提出者（純粋FIFO）サマリー");
      expect(html).toContain("予想マージ日 (P50 中央値)");
      expect(html).toContain("予想マージ日 (P75 75%点)");
      expect(html).toContain("追い越し実態の分離内訳");
      expect(html).toContain("常連・特急: <strong>9</strong> 件 / 初回: <strong>1</strong> 件");

      // 新指標: 最上部の予想パネルの順位消化（24時間で50件消化 = 日速50件、残り100件で約2日後）
      expect(html).toContain("予想マージ日（3 つの仮説の比較）");
      expect(html).toContain("① 順位消化");
      expect(html).toContain("直近 1.0 日（24.0 時間）で 50 件減（50 件/日）");
      expect(html).toContain("約 2 日後");

      // 新指標: カレンダー距離 (2026-10-01 〜 2026-10-25 = 24 日)
      expect(html).toContain("カレンダー距離 (日付ギャップ)");
      expect(html).toContain("差 24 日");

      // 新指標: パーセンタイル統計
      expect(html).toContain("マージ実績の所要日数統計");
      expect(html).toContain("手番所要日数 (Turn Latency)");
      expect(html).toContain("4.2");
      expect(html).toContain("6.8");
      expect(html).toContain("Ready 成立後所要日数 (Ready Latency)");
      expect(html).toContain("2.5");
      expect(html).toContain("5");
      expect(html).toContain("通算所要日数 (Total Lifetime)");
      expect(html).toContain("30.5");
      expect(html).toContain("45");
      expect(html).toContain("初回提出者コホート実績");
      expect(html).toContain("37.5");
      expect(html).toContain("39");
      expect(html).toContain(
        "うち初回提出者: <strong>1</strong> 件 / 常連・特急レーン: <strong>9</strong> 件",
      );

      // site/data へのコピー確認
      expect(existsSync(join(outputDir, "data", "latest-progress.json"))).toBe(true);
      expect(existsSync(join(outputDir, "data", "progress-history.csv"))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("前線巻き戻り（赤バッジ）および統計 null / 0 のハンドリングを正しく処理する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-test-null-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");

    mkdirSync(dataDir, { recursive: true });

    // 統計値が null（実績なし）と 0（即日マージ実績）の混在
    const dummyProgress = {
      TimestampJst: "2026-11-07 12:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 123456,
      PrTitle: "Test package",
      FrontNumber: 119950, // 前回 120000 から減少（巻き戻り）
      ActiveAhead: 150,
      TotalAhead: 200,
      Behind: 40,
      WaitDays: 6.0,
      TotalMedianDays: null,
      TotalP75Days: null,
      TurnMedianDays: 0, // 実測 0 日
      TurnP75Days: 0,
      ReadyMedianDays: null,
      ReadyP75Days: null,
    };
    writeFileSync(join(dataDir, "latest-progress.json"), JSON.stringify(dummyProgress), "utf-8");

    // 前線番号 120000 -> 119950 (-50 番号巻き戻り)
    const dummyCsv = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis"
"2026-11-06 12:00:00","123456","120000","2026-10-01 10:00","100","150","50","5.0","5.0","5.0","1","updated"
"2026-11-07 12:00:00","123456","119950","2026-09-30 10:00","150","200","40","6.0","6.0","6.0","1","updated"
`;
    writeFileSync(join(dataDir, "progress-history.csv"), dummyCsv, "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");

      // 前線巻き戻り: -50 が delta-rewind（赤）として表示される
      expect(html).toContain("delta-badge delta-rewind");
      expect(html).toContain("-50");

      // 統計値: null はハイフン（-）、実測 0 は "0 日" として表示され区別される
      expect(html).toContain("通算所要日数 (Total Lifetime)");
      expect(html).toContain('P50: <span style="color: var(--text-muted);">-</span>');
      expect(html).toContain("手番所要日数 (Turn Latency)");
      expect(html).toContain(
        '<strong>0</strong> <span style="font-size: 0.875rem; font-weight: normal;">日</span>',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildDashboard: 読み込み失敗時の中断", () => {
  test.each([
    ["latest-progress.json", "進捗スナップショット", "file"],
    ["latest-depths.json", "キュー境界スナップショット", "file"],
    ["progress-history.csv", "履歴 CSV", "dir"],
  ])(
    "%s が壊れている場合は空のダッシュボードを出力せず、パス付きで中断する",
    (file, label, kind) => {
      const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-broken-"));
      try {
        const dataDir = join(tempDir, "data");
        mkdirSync(dataDir, { recursive: true });
        if (kind === "dir") {
          // ディレクトリを置いて「存在するが読めない」状態を作る
          mkdirSync(join(dataDir, file));
        } else {
          writeFileSync(join(dataDir, file), "{ broken json", "utf-8");
        }

        const outputDir = join(tempDir, "site");
        expect(() => buildDashboard({ dataDir, outputDir })).toThrow(label);
        expect(() => buildDashboard({ dataDir, outputDir })).toThrow(file);
        expect(existsSync(join(outputDir, "index.html"))).toBeFalse();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe("buildDashboard: 遭難の底と履歴の扱い", () => {
  test("遭難の底を専用の表に更新の古い順で表示し、旧定義の履歴は推移に含めない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-stale-"));
    try {
      const dataDir = join(tempDir, "data");
      const outputDir = join(tempDir, "site");
      mkdirSync(dataDir, { recursive: true });

      const item = (number: number, updated: string) => ({
        PR: `#${number}`,
        Number: number,
        作成日時: "2026-10-09 13:39",
        更新日時: "2026-10-09 14:54",
        CreatedAt: "2026-10-09T04:39:00Z",
        UpdatedAt: updated,
        タイトル: `Stale package ${number}`,
        Title: `Stale package ${number}`,
        Url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
      });
      writeFileSync(
        join(dataDir, "latest-depths.json"),
        JSON.stringify({
          Timestamp: "2026-11-08T05:54:00Z",
          TimestampJst: "2026-11-08 14:54:00",
          StaleBottom: [item(449320, "2026-10-09T05:54:00Z"), item(449314, "2026-10-09T07:46:00Z")],
          FirstTimerBottom: [
            {
              ...item(450100, "2026-10-09T08:00:00Z"),
              Author: "alice",
              AuthorAssociation: "NONE",
            },
          ],
        }),
        "utf-8",
      );
      writeFileSync(
        join(dataDir, "latest-progress.json"),
        JSON.stringify({ TargetPr: 123, TimestampJst: "2026-11-08 14:54:00" }),
        "utf-8",
      );
      // 旧定義の行（QueueBasis なし）のみ
      writeFileSync(
        join(dataDir, "progress-history.csv"),
        [
          '"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount"',
          '"2026-11-06 12:00:00","123","119950","2026-09-30 10:00","1618","2133","40","4.5","4.5","4.5","1"',
          "",
        ].join("\n"),
        "utf-8",
      );

      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");

      expect(html).toContain("優等生の底（順番待ちの先頭）");
      expect(html).toContain("初回提出者の底（真の FIFO 前線）");
      expect(html).toContain("#450100");
      expect(html).toContain("alice");
      expect(html.indexOf("#449320")).toBeLessThan(html.indexOf("#449314"));
      // 観測時刻(11-08 05:54Z) − 最終更新(10-09 05:54Z) = 30 日
      expect(html).toContain("30 日");
      expect(html).toContain("旧定義の履歴は比較できないため表示しません");
      expect(html).not.toContain("1,618");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildDashboard: マージ時期の予想", () => {
  const stale = (number: number, updated: string) => ({
    PR: `#${number}`,
    Number: number,
    作成日時: "",
    更新日時: "",
    CreatedAt: updated,
    UpdatedAt: updated,
    タイトル: "",
    Title: "",
    Url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
  });
  const snapshot = (timestamp: string, pr: number, updated: string) => ({
    DepthsVersion: CURRENT_DEPTHS_VERSION,
    Timestamp: timestamp,
    TimestampJst: "",
    Repository: "microsoft/winget-pkgs",
    TargetPr: null,
    HealthyBottom: [],
    AbsoluteBottom: [],
    StaleBottom: [stale(pr, updated)],
    ExpressLane: [],
  });

  const setup = (history: string) => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-forecast-"));
    const dataDir = join(tempDir, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "latest-depths.json"),
      JSON.stringify({
        Timestamp: "2026-11-08T00:00:00Z",
        TargetPr: {
          Number: 123,
          Title: "t",
          Url: "https://github.com/microsoft/winget-pkgs/pull/123",
          CreatedAt: "2026-10-28T00:00:00Z",
          CreatedAtJst: "",
          UpdatedAt: "2026-10-20T00:00:00Z",
        },
        StaleBottom: [stale(10, "2026-10-10T00:00:00Z")],
      }),
      "utf-8",
    );
    writeFileSync(join(dataDir, "depths-history.jsonl"), history, "utf-8");
    return { tempDir, dataDir, outputDir: join(tempDir, "site") };
  };

  test("更新順の 2 つのモデルの予想日を、予想パネルに並べて表示する", () => {
    // 先頭が 24 時間で 1 日分進む（1 日/日）。遅れ 29 日、基準 PR との更新差 10 日 → 10 日後（2026-11-18）
    const history = [
      snapshot("2026-11-07T00:00:00Z", 10, "2026-10-09T00:00:00Z"),
      snapshot("2026-11-08T00:00:00Z", 10, "2026-10-10T00:00:00Z"),
    ]
      .map((s) => JSON.stringify(s))
      .join("\n");
    const { tempDir, dataDir, outputDir } = setup(history);
    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("② 更新順");
      expect(html).toContain("先頭が実時間と同じ速度（1 日/日）で進む場合");
      expect(html).toContain("実測した先頭の進みが続く場合");
      expect(html).toContain("<strong>2026-11-18</strong>");
      expect(html).toContain("（約 10 日後）");
      expect(html).toContain("実測の進み: 1 日/日（直近 24 時間）");
      expect(html).toContain("仮説② の根拠");
      expect(html).toContain("上部の統合時系列チャートを参照");
      expect(html).toContain('aria-label="待ち件数と底の遅れの推移（統合時系列チャート）"');
      expect(html).toContain("優等生の底 更新からの遅れ");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("観測が 1 件だけなら先頭の遅れのテーブルは出さず、理由を示す", () => {
    const history = JSON.stringify(snapshot("2026-11-08T00:00:00Z", 10, "2026-10-10T00:00:00Z"));
    const { tempDir, dataDir, outputDir } = setup(history);
    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("観測が 2 件以上たまると推移を表示します");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("作成順の予想を中央値から求めた日付と進捗バーで示し、範囲を見出しに出してページの最上部に置く", () => {
    const history = JSON.stringify(snapshot("2026-11-08T00:00:00Z", 10, "2026-10-10T00:00:00Z"));
    const { tempDir, dataDir, outputDir } = setup(history);
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-08T00:00:00Z",
        TargetPr: 123,
        TotalMedianDays: 44.5,
        TotalP75Days: 45,
      }),
      "utf-8",
    );
    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("③ 作成順");
      // 起票 2026-10-28 + 44.5 日 = 2026-12-11、観測 2026-11-08 から 33.5 日後
      expect(html).toContain("<strong>2026-12-11</strong>");
      expect(html).toContain("（約 33.5 日後）");
      expect(html).toContain("75%点の日数でマージされる場合");
      expect(html).toContain("起票から 11 日 / 通算所要日数の中央値 44.5 日（25%）");
      expect(html).toContain('class="progress-bar"');
      // 範囲は主な予想の最小〜最大（更新順の 2026-11-18 から作成順の 2026-12-11）
      expect(html).toContain("2026-11-18 〜 2026-12-11");
      expect(html).toContain("約 10〜33.5 日後");
      expect(html).toContain('aria-label="3 つの仮説による予想マージ日"');
      // 順位消化の注意（更新の入れ替わりを含む）
      expect(html).toContain("実際の消化より速く出ることがあります");
      // 予想パネルは、上部の統計カードより前に出す
      expect(html.indexOf("予想マージ日（3 つの仮説の比較）")).toBeLessThan(
        html.indexOf("実質待ち件数 (更新順の順位)"),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("通算所要日数の統計が無い旧スナップショットでは、作成順の予想を出さず理由を示す", () => {
    const history = JSON.stringify(snapshot("2026-11-08T00:00:00Z", 10, "2026-10-10T00:00:00Z"));
    const { tempDir, dataDir, outputDir } = setup(history);
    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("③ 作成順");
      expect(html).toContain("通算所要日数の統計または基準 PR の起票日時が未記録です");
      expect(html).not.toContain('class="progress-bar"');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("先頭が進んでいなければ観測速度モデルは理由付きで算出不能と表示する", () => {
    const history = [
      snapshot("2026-11-07T00:00:00Z", 10, "2026-10-10T00:00:00Z"),
      snapshot("2026-11-08T00:00:00Z", 10, "2026-10-10T00:00:00Z"),
    ]
      .map((s) => JSON.stringify(s))
      .join("\n");
    const { tempDir, dataDir, outputDir } = setup(history);
    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("観測期間内に先頭が進んでいないため算出できません");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("履歴 JSONL が壊れている場合は空の予想を出さずパス付きで中断する", () => {
    const { tempDir, dataDir, outputDir } = setup("{ broken\n");
    try {
      expect(() => buildDashboard({ dataDir, outputDir })).toThrow("キュー境界履歴");
      expect(() => buildDashboard({ dataDir, outputDir })).toThrow("depths-history.jsonl");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("buildDashboard: 過去実績との比較", () => {
  const sample = (number: number, created: string, merged: string, total: number) => ({
    number,
    title: `Merged <${number}>`,
    createdAt: created,
    latestCommittedDate: created,
    commitCount: 2,
    readyAt: created,
    mergedAt: merged,
    totalDays: total,
    turnDays: total - 1,
    days: total - 2,
  });

  const build = (opts: { samples: ReturnType<typeof sample>[]; skipped?: number }) => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-bench-"));
    const dataDir = join(tempDir, "data");
    mkdirSync(dataDir, { recursive: true });
    const stats = calculateProgressStats(opts.samples, opts.skipped ?? 0);
    const snapshot = createProgressSnapshot({
      now: new Date("2026-11-08T00:00:00Z"),
      repository: "microsoft/winget-pkgs",
      targetPr: 500,
      prTitle: "Target",
      prUrl: "https://github.com/microsoft/winget-pkgs/pull/500",
      prState: "OPEN",
      frontNumber: 100,
      frontCreatedAt: "2026-10-01 00:00",
      activeAhead: 10,
      totalAhead: 20,
      behind: 5,
      totalLifetimeDays: 7,
      turnLatencyDays: 6,
      waitDays: 5,
      commitCount: 1,
      stats,
      lookbackDays: 30,
      skippedCount: opts.skipped ?? 0,
      rivals: [
        {
          number: 470,
          title: "Rival <script>",
          createdAt: "2026-10-28T00:00:00Z",
          updatedAt: "2026-11-06T00:00:00Z",
          url: "https://github.com/microsoft/winget-pkgs/pull/470",
        },
      ],
      samples: opts.samples,
      targetCreatedAt: new Date("2026-11-01T00:00:00Z"),
      targetReadyAt: new Date("2026-11-01T01:00:00Z"),
    });
    writeFileSync(join(dataDir, "latest-progress.json"), JSON.stringify(snapshot), "utf-8");
    writeFileSync(
      join(dataDir, "latest-depths.json"),
      JSON.stringify({
        Timestamp: "2026-11-08T00:00:00Z",
        TargetPr: { Number: 500, Title: "Target", Url: "u", CreatedAt: "2026-11-01T00:00:00Z" },
        HealthyBottom: [],
        AbsoluteBottom: [
          {
            Number: 1111,
            Title: "Absolute <b>",
            Url: "https://github.com/microsoft/winget-pkgs/pull/1111",
            作成日時: "2026-01-01 00:00",
            更新日時: "2026-01-02 00:00",
          },
        ],
        StaleBottom: [],
        ExpressLane: Array.from({ length: 5 }, (_, i) => ({
          Number: 9000 + i,
          Title: `Express ${i}`,
          Url: `https://github.com/microsoft/winget-pkgs/pull/${9000 + i}`,
        })),
      }),
      "utf-8",
    );
    const outputDir = join(tempDir, "site");
    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      return readFileSync(htmlPath, "utf-8");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  };

  const samples = [
    sample(400, "2026-10-20T00:00:00Z", "2026-11-04T00:00:00Z", 15),
    sample(600, "2026-11-02T00:00:00Z", "2026-11-05T00:00:00Z", 3),
  ];

  test("最大値・位置づけ・追い越し・ライバル・サンプル・真の大底を表示し、HTML をエスケープする", () => {
    const html = build({ samples, skipped: 3 });

    expect(html).toContain("直近 30 日間 / 採用 2 件・除外 3 件");
    expect(html).toContain("最大:");
    expect(html).toContain("基準 PR の現在:");
    expect(html).toContain("はこれより短い期間でマージ済み");
    expect(html).toContain("サンプルが少ないため、数値は変動しやすくなっています");

    expect(html).toContain("追い越しの比較");
    expect(html).toContain("自分より後に作成され、マージ済み（追い越し）");

    expect(html).toContain("直前のライバル PR");
    expect(html).toContain("#470");
    expect(html).toContain("Rival &lt;script&gt;");
    expect(html).not.toContain("Rival <script>");

    expect(html).toContain("比較に使ったサンプル（2 件）");
    expect(html).toContain("pull/400");

    expect(html).toContain("真の大底");
    expect(html).toContain("#1111");
    // 特急レーンは 5 件まで表示する
    expect(html).toContain("#9004");
  });

  test("追い越しの表は作成順・成立順の 3 行にし、起票順と同じ意味になる PR 番号の行は出さない", () => {
    const html = build({ samples });
    const table = html.slice(html.indexOf("追い越しの比較"), html.indexOf("トリアージキュー構造"));
    expect(table.match(/<tr><td>/g)).toHaveLength(3);
    expect(table).not.toContain("PR 番号");
  });

  test("トリアージ構造の図は作成順の件数を矢印に、更新順の順位を基準 PR に示し、前線を重複させない", () => {
    const html = build({ samples });
    const flow = html.slice(
      html.indexOf('<div class="flow-container">'),
      html.indexOf("直前のライバル"),
    );
    // 前線と基準 PR の間は作成順の累積待ち（20）。更新順の順位（10）は基準 PR のノードに示す
    expect(flow).toContain("作成順で 20 件");
    expect(flow).toContain("更新順の順位 10");
    expect(flow).not.toContain("… 10 件");
    expect(flow.match(/class="flow-node/g)).toHaveLength(3);
    expect(flow).toContain("消化前線（健康的大底）");
  });

  test("統計カードの P50 / P75 / 最大は途中で折り返さず、favicon を埋め込んで 404 を避ける", () => {
    const html = build({ samples });
    expect(html.match(/<span style="white-space: nowrap;">(P50|P75|最大): /g)?.length).toBe(9);
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,');
  });

  test("サンプルが多いときは、統計に使った総数を見出しに、一覧は新しい順の一部であることを示す", () => {
    // 35 件を採用（マージが新しい順に #1000 が最古、#1034 が最新）
    const many = Array.from({ length: 35 }, (_, i) =>
      sample(
        1000 + i,
        "2026-10-20T00:00:00Z",
        new Date(Date.parse("2026-10-01T00:00:00Z") + i * 86_400_000).toISOString(),
        10 + i / 10,
      ),
    );
    const html = build({ samples: many });

    expect(html).toContain("比較に使ったサンプル（35 件）");
    expect(html).toContain("マージ日時の新しい順に 30 件表示");
    expect(html).toContain("pull/1034");
    // 古い 5 件（#1000〜#1004）は一覧に載せない
    expect(html).not.toContain("pull/1004");
    expect(html).toContain("pull/1005");
  });

  test("サンプルがないときは追い越し・サンプル一覧を出さず、除外件数だけ示す", () => {
    const html = build({ samples: [], skipped: 4 });

    expect(html).toContain("採用 0 件・除外 4 件");
    expect(html).not.toContain("追い越しの比較");
    expect(html).not.toContain("比較に使ったサンプル");
    expect(html).toContain("直前のライバル PR");
  });

  test("初回提出者コホートUX改善: ファーストビュー、独立統計ブロック、2カラム底比較・常連除外バッジ、サンプル色分け、4系列2軸チャートを正しく出力する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-first-timer-ux-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const dummyProgress = {
      Timestamp: "2026-11-08T12:00:00Z",
      TimestampJst: "2026-11-08 21:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: 123456,
      PrTitle: "Test First Timer App",
      FrontNumber: 120000,
      FrontCreatedAt: "2026-10-01 10:00",
      ActiveAhead: 1500,
      TotalAhead: 2200,
      Behind: 300,
      WaitDays: 35.0,
      TotalLifetimeDays: 35.0,
      TotalMedianDays: 28.0,
      TotalP75Days: 42.0,
      TurnMedianDays: 3.5,
      TurnP75Days: 5.5,
      ReadyMedianDays: 2.0,
      ReadyP75Days: 4.0,
      FirstTimerMedianDays: 37.5,
      FirstTimerP75Days: 39.4,
      FirstTimerSampleCount: 12,
      Comparison: {
        LaterCreated: 56,
        EarlierCreated: 100,
        LaterReady: 20,
        NewerNumber: 56,
        OlderNumber: 100,
        Verdict: "overtaken",
        FirstTimerLaterCreated: 0,
        RepeatOrExpressLaterCreated: 56,
        UnknownLaterCreated: 0,
      },
      Samples: [
        {
          Number: 200001,
          Relation: "newer",
          CommitCount: 1,
          TurnDays: 37.5,
          TotalDays: 37.5,
          ReadyDays: 37.5,
          LatestCommittedDate: "2026-10-01T00:00:00Z",
          MergedAt: "2026-11-07T12:00:00Z",
          IsFirstTimer: true,
        },
        {
          Number: 200002,
          Relation: "newer",
          CommitCount: 1,
          TurnDays: 5.0,
          TotalDays: 5.0,
          ReadyDays: 5.0,
          LatestCommittedDate: "2026-11-02T00:00:00Z",
          MergedAt: "2026-11-07T14:00:00Z",
          IsFirstTimer: false,
        },
        {
          Number: 200003,
          Relation: "newer",
          CommitCount: 1,
          TurnDays: 10.0,
          TotalDays: 10.0,
          ReadyDays: 10.0,
          LatestCommittedDate: "2026-10-25T00:00:00Z",
          MergedAt: "2026-11-05T00:00:00Z",
        },
      ],
    };
    writeFileSync(join(dataDir, "latest-progress.json"), JSON.stringify(dummyProgress), "utf-8");

    const dummyDepths = {
      Timestamp: "2026-11-08T12:00:00Z",
      TimestampJst: "2026-11-08 21:00:00",
      TargetPr: {
        Number: 123456,
        Title: "Test First Timer App",
        CreatedAtJst: "2026-10-04 10:00",
        CreatedAt: "2026-10-04T01:00:00Z",
      },
      StaleBottom: [
        {
          Number: 440001,
          Title: "Stale by Contributor",
          Url: "https://github.com/microsoft/winget-pkgs/pull/440001",
          Author: "frequent-contributor",
          AuthorAssociation: "CONTRIBUTOR",
          CreatedAt: "2026-10-02T00:00:00Z",
          UpdatedAt: "2026-10-02T00:00:00Z",
        },
        {
          Number: 440002,
          Title: "Stale by First Timer",
          Url: "https://github.com/microsoft/winget-pkgs/pull/440002",
          Author: "first-timer-user",
          AuthorAssociation: "NONE",
          CreatedAt: "2026-10-03T00:00:00Z",
          UpdatedAt: "2026-10-03T00:00:00Z",
        },
      ],
      FirstTimerBottom: [
        {
          Number: 440002,
          Title: "Stale by First Timer",
          Url: "https://github.com/microsoft/winget-pkgs/pull/440002",
          Author: "first-timer-user",
          AuthorAssociation: "NONE",
          CommitCount: 3,
          CreatedAt: "2026-10-03T00:00:00Z",
          UpdatedAt: "2026-10-03T00:00:00Z",
        },
        {
          Number: 440003,
          Title: "Legacy First Timer Row Without CommitCount",
          Url: "https://github.com/microsoft/winget-pkgs/pull/440003",
          Author: "legacy-first-timer",
          AuthorAssociation: "NONE",
          CreatedAt: "2026-10-04T00:00:00Z",
          UpdatedAt: "2026-10-04T00:00:00Z",
        },
      ],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(dummyDepths), "utf-8");

    const dummyCsv = `"Timestamp","TargetPr","FrontNumber","FrontCreatedAt","ActiveAhead","TotalAhead","Behind","TotalLifetimeDays","TurnLatencyDays","WaitDays","CommitCount","QueueBasis"
"2026-11-07 12:00:00","123456","119900","2026-09-30 10:00","1600","2300","280","34.0","34.0","34.0","1","updated"
"2026-11-08 12:00:00","123456","120000","2026-10-01 10:00","1500","2200","300","35.0","35.0","35.0","1","updated"
`;
    writeFileSync(join(dataDir, "progress-history.csv"), dummyCsv, "utf-8");

    const depthsLines = [
      // 旧定義（DepthsVersion 未設定）のスナップショットは混在しても除外される
      JSON.stringify({
        Timestamp: "2026-11-06T12:00:00Z",
        StaleBottom: [{ Number: 439999, UpdatedAt: "2026-09-01T00:00:00Z" }],
        FirstTimerBottom: [
          {
            Number: 439998,
            CreatedAt: "2026-09-01T00:00:00Z",
            UpdatedAt: "2026-09-02T00:00:00Z",
          },
        ],
      }),
      JSON.stringify({
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-07T12:00:00Z",
        StaleBottom: [{ Number: 440001, UpdatedAt: "2026-10-01T12:00:00Z" }],
        FirstTimerBottom: [
          {
            Number: 440002,
            CreatedAt: "2026-10-01T12:00:00Z",
            UpdatedAt: "2026-10-02T12:00:00Z",
          },
        ],
      }),
      JSON.stringify({
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-08T12:00:00Z",
        StaleBottom: [{ Number: 440001, UpdatedAt: "2026-10-02T00:00:00Z" }],
        FirstTimerBottom: [
          {
            Number: 440002,
            CreatedAt: "2026-10-02T00:00:00Z",
            UpdatedAt: "2026-10-03T00:00:00Z",
          },
        ],
      }),
    ];
    writeFileSync(join(dataDir, "depths-history.jsonl"), depthsLines.join("\n"), "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");

      // 1. ファーストビューサマリー
      expect(html).toContain("🎯 初回提出者（純粋FIFO）サマリー");
      expect(html).toContain("純粋FIFO待機列 準拠");
      expect(html).toContain("予想マージ日 (P50 中央値)");
      expect(html).toContain("残り約 2.5 日");
      expect(html).toContain("予想マージ日 (P75 75%点)");
      expect(html).toContain("残り約 4.4 日");
      expect(html).toContain("後発マージ計 56 件");
      expect(html).toContain("常連・特急: <strong>56</strong> 件 / 初回: <strong>0</strong> 件");
      expect(html).toContain("✨ 採用サンプル内で確定した初回提出者の追い越し: 0 件");

      // 2. 統合チャート（4系列・2軸）
      expect(html).toContain('aria-label="待ち件数と底の遅れの推移（統合時系列チャート）"');
      expect(html).toContain("待ち件数"); // 左軸見出し
      expect(html).toContain("先頭の経過・遅れ（日）"); // 右軸見出し
      expect(html).toContain("実質待ち（更新順）");
      expect(html).toContain("累積待ち（作成順）");
      expect(html).toContain("優等生の底 更新からの遅れ");
      expect(html).toContain("🌱 初回提出者の底 起票からの経過");
      expect(html.match(/<polyline /g)?.length).toBe(4);

      // 3. マージ実績統計カードの分離
      expect(html).toContain("🌱 初回提出者コホート実績（純粋FIFO待機列）");
      expect(html).toContain("採用 12 件");
      expect(html).toContain("👥 全体実績（常連・特急レーンを含む全サンプル）");

      // 4. 底の横並び比較 ＆ コミット数列 ＆ 常連除外バッジ
      expect(html).toContain("待機列の底の比較（優等生 vs 初回提出者）");
      expect(html).toContain("左は「1コミット完全放置」の待機前線（常連含む）");
      expect(html).toContain("🧗 優等生の底（順番待ちの先頭）");
      expect(html).toContain("🌱 初回提出者の底（真の FIFO 前線）");
      expect(html).toContain("手直し込み初回全体");
      expect(html).toContain("起票日時の古い順です");
      expect(html).toContain("<th>コミット数</th>");
      expect(html).toContain("<td>3</td>"); // #440002 の CommitCount
      expect(html).toContain("<td>-</td>"); // #440003 (旧データ互換)
      expect(html).toContain("常連除外"); // #440001 (CONTRIBUTOR) に付与される

      // 5. サンプル一覧のコホートバッジ色分け
      expect(html).toContain("🌱 初回");
      expect(html).toContain("⚡ 常連");
      expect(html).toContain("⏳ 未判定");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("runExploreDepths で探索された実際の StaleBottom データから、CONTRIBUTOR 行に常連除外バッジが描画される", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-explore-badge-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const outputPath = join(dataDir, "latest-depths.json");
    const historyPath = join(dataDir, "depths-history.jsonl");

    const mockClient = {
      getPullRequest: async () => ({
        number: 123456,
        title: "Target",
        url: "https://github.com/microsoft/winget-pkgs/pull/123456",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      }),
      searchIssues: async () => [
        {
          number: 550001,
          title: "PR by Frequent Contributor",
          html_url: "https://github.com/microsoft/winget-pkgs/pull/550001",
          created_at: "2026-09-10T00:00:00Z",
          updated_at: "2026-09-10T00:00:00Z",
          author: "frequent-contributor",
          author_association: "CONTRIBUTOR",
        },
      ],
      graphql: async (_query: string, variables?: Record<string, unknown>) => {
        const searchQuery = String(variables?.query ?? "");
        if (searchQuery.includes("sort:updated-asc")) {
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 550001,
                  title: "PR by Frequent Contributor",
                  url: "https://github.com/microsoft/winget-pkgs/pull/550001",
                  createdAt: "2026-09-10T00:00:00Z",
                  updatedAt: "2026-09-10T00:00:00Z",
                  author: { login: "frequent-contributor" },
                  authorAssociation: "CONTRIBUTOR",
                  commits: { totalCount: 1 },
                  labels: { nodes: [{ name: "New-Package" }] },
                },
              ],
            },
          };
        }
        return {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        };
      },
    } as unknown as GitHubApiClient;

    await runExploreDepths(
      {
        targetPr: 123456,
        repository: "microsoft/winget-pkgs",
        outputPath,
        historyPath,
        noTargetPr: false,
        noHistory: false,
        asJson: true,
      },
      mockClient,
      () => {},
    );

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");
      // Search API で取得された CONTRIBUTOR の行に「常連除外」バッジが付与されていること
      expect(html).toContain("550001");
      expect(html).toContain("常連除外");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label: "AuthorAssociation=NONE かつ AuthorMergedCount>=1 の隠れ常連に常連除外バッジが付く",
      association: "NONE",
      mergedCount: 2,
      expectBadge: true,
    },
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount=0 の初回提出者には常連除外バッジが付かない",
      association: "NONE",
      mergedCount: 0,
      expectBadge: false,
    },
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount 未設定（旧データ）には常連除外バッジが付かない",
      association: "NONE",
      mergedCount: undefined,
      expectBadge: false,
    },
    {
      label: "AuthorAssociation=CONTRIBUTOR には AuthorMergedCount 未設定でも常連除外バッジが付く",
      association: "CONTRIBUTOR",
      mergedCount: undefined,
      expectBadge: true,
    },
  ])("StaleBottom 常連除外バッジ判定: $label", ({ association, mergedCount, expectBadge }) => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-repeater-badge-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const dummyDepths = {
      Timestamp: "2026-11-08T12:00:00Z",
      TimestampJst: "2026-11-08 21:00:00",
      StaleBottom: [
        {
          Number: 551001,
          Title: "Stale Candidate",
          Url: "https://github.com/microsoft/winget-pkgs/pull/551001",
          Author: "candidate-user",
          AuthorAssociation: association,
          ...(mergedCount !== undefined ? { AuthorMergedCount: mergedCount } : {}),
          CreatedAt: "2026-10-01T12:00:00Z",
          UpdatedAt: "2026-10-10T12:00:00Z",
        },
      ],
      FirstTimerBottom: [
        {
          Number: 551002,
          Title: "Multi-commit Reworked First Timer",
          Url: "https://github.com/microsoft/winget-pkgs/pull/551002",
          Author: "reworked-first-timer",
          AuthorAssociation: "NONE",
          CommitCount: 4,
          // 起票は 36.0 日前、更新は 1.0 日前
          CreatedAt: "2026-10-03T12:00:00Z",
          UpdatedAt: "2026-11-07T12:00:00Z",
        },
      ],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(dummyDepths), "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");

      const staleSection = html
        .split("🧗 優等生の底（順番待ちの先頭）")[1]
        .split("🌱 初回提出者の底（真の FIFO 前線）")[0];
      const firstTimerSection = html
        .split("🌱 初回提出者の底（真の FIFO 前線）")[1]
        .split("🔮 仮説② の根拠")[0];

      // 左表（優等生の底）は「更新からの経過」（29 日）＋常連除外バッジ判定
      expect(staleSection).toContain("<th>更新からの経過</th>");
      expect(staleSection).toContain("<td>29 日</td>");
      if (expectBadge) {
        expect(staleSection).toContain(">常連除外<");
      } else {
        expect(staleSection).not.toContain(">常連除外<");
      }

      // 右表（初回提出者の底）は「起票からの経過」（36 日）であり、更新からの経過（1 日）ではない
      expect(firstTimerSection).toContain("<th>起票からの経過</th>");
      expect(firstTimerSection).not.toContain("<th>更新からの経過</th>");
      expect(firstTimerSection).toContain("<td>36 日</td>");
      expect(firstTimerSection).not.toContain("<td>1 日</td>");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("renderFirstTimerHeroSummary: 未観測・旧形式・未判定ありのフォールバックが安全に処理される", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-summary-fallback-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    // ケース 1: Comparison が存在しない（未観測）
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({ TargetPr: 123456 }),
      "utf-8",
    );
    let html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("追い越しの観測データなし");
    expect(html).not.toContain("完全な作成順で進行中");

    // ケース 2: 旧形式スナップショット（LaterCreated のみあり、コホート別内訳なし）
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        Comparison: {
          LaterCreated: 15,
          EarlierCreated: 30,
        },
      }),
      "utf-8",
    );
    html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("後発マージ計 15 件");
    expect(html).toContain("初回/常連の内訳は未分類（旧データ）");
    expect(html).not.toContain("常連・特急: <strong>15</strong> 件"); // 勝手に常連に計上しない
    expect(html).not.toContain("完全な作成順で進行中");

    // ケース 3: 未判定あり（FirstTimerLaterCreated: 0, UnknownLaterCreated: 7）
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        Comparison: {
          LaterCreated: 20,
          EarlierCreated: 30,
          FirstTimerLaterCreated: 0,
          RepeatOrExpressLaterCreated: 13,
          UnknownLaterCreated: 7,
        },
      }),
      "utf-8",
    );
    html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain(
      "常連・特急: <strong>13</strong> 件 / 初回: <strong>0</strong> 件 / 未判定: <strong>7</strong> 件",
    );
    expect(html).toContain("採用サンプル内で確定した初回追い越し 0 件（未判定 7 件）");
    expect(html).not.toContain("完全な作成順で進行中");

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renderFirstTimerHeroSummary & renderFirstTimerCohortBlock: FirstTimerLookbackDays が集計期間バッジに反映される", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-ft-lookback-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    // FirstTimerLookbackDays: 90 が指定された場合
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerSampleCount: 8,
      }),
      "utf-8",
    );
    let html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("過去 90 日間の純粋FIFO待機列 準拠");
    expect(html).toContain("（過去 90 日間 / サンプル 8 件）");
    expect(html).toContain("過去 90 日間・採用 8 件");

    // FirstTimerLookbackDays 未指定で LookbackDays: 45 の場合
    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 45,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerSampleCount: 4,
      }),
      "utf-8",
    );
    html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("過去 45 日間の純粋FIFO待機列 準拠");
    expect(html).toContain("（過去 45 日間 / サンプル 4 件）");
    expect(html).toContain("過去 45 日間・採用 4 件");

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("renderFirstTimerHeroSummary: FirstTimerTurnMedianDays と FirstTimerTurnP75Days が設定されている場合に最終コミット後 (Turn) が出力される", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-ft-turn-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerTurnMedianDays: 5.5,
        FirstTimerTurnP75Days: 8.2,
        FirstTimerSampleCount: 8,
      }),
      "utf-8",
    );
    const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
    expect(html).toContain("最終コミット後 (Turn): <strong>5.5</strong> 日");
    expect(html).toContain("最終コミット後 (Turn): <strong>8.2</strong> 日");

    rmSync(tempDir, { recursive: true, force: true });
  });
});
