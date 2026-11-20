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
      // 待ち件数の推移・正常底統合チャート
      expect(html).toContain('aria-label="待ち件数と正常底の推移（統合時系列チャート）"');
      expect(html.match(/<polyline /g)?.length).toBeGreaterThanOrEqual(2);
      expect(html).toContain("+50"); // 前線番号増加（進行）

      // ファーストビューの統合処理バンドヒーローカード
      expect(html).toContain("着地予測（統合処理バンド）");
      expect(html).toContain("本命予想（中央値バンド）");
      expect(html).toContain("全体レンジ（前線 〜 正常底）");
      expect(html).toContain("🌱 初回提出者コホート実績（過去 90 日・5 件）");
      expect(html).toContain("生涯マージ1件の初回提出者（手直し・ラベル履歴を含む）");
      expect(html).toContain(
        "うち初回提出者: <strong>1</strong> 件 / 常連・特急レーン: <strong>9</strong> 件",
      );
      expect(html).toContain("健康的大底（最古健康PR）");
      expect(html).toContain("<th>健康的大底 PR</th>");
      expect(html).not.toContain("現在の消化前線");
      expect(html).not.toContain("<th>消化前線 PR</th>");

      // 検証用詳細の順位消化（24時間で50件消化 = 日速50件、残り100件で約2日後）
      expect(html).toContain("🔍 統合処理バンドの内訳と 2 仮説比較（検証用詳細）");
      expect(html).not.toContain("🔮 仮説② の根拠");
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

describe("buildDashboard: マージ正常底と旧定義履歴の扱い", () => {
  test("マージ正常底を専用の表に起票の古い順で表示し、旧定義の履歴は推移に含めない", () => {
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
        タイトル: `Healthy package ${number}`,
        Title: `Healthy package ${number}`,
        Url: `https://github.com/microsoft/winget-pkgs/pull/${number}`,
      });
      writeFileSync(
        join(dataDir, "latest-depths.json"),
        JSON.stringify({
          Timestamp: "2026-11-08T05:54:00Z",
          TimestampJst: "2026-11-08 14:54:00",
          HealthyBottom: [
            item(449320, "2026-10-09T05:54:00Z"),
            item(449314, "2026-10-09T07:46:00Z"),
          ],
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

      expect(html).toContain("🚀 マージ前線（直近マージ実績・早ければ）");
      expect(html).toContain("⚓ マージ正常底（健康的大底・遅くとも）");
      expect(html).toContain("#450100");
      expect(html).toContain("alice");
      expect(html.indexOf("#449320")).toBeLessThan(html.indexOf("#449314"));
      // 観測時刻(11-08 05:54Z) − 起票日時(10-09 04:39Z) = 30.1 日
      expect(html).toContain("30.1 日");
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

  test("作成順（② 作成順）の予想を中央値から求めた日付と進捗バーで示し、仮説②（更新順）および根拠セクションは出さない", () => {
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
      expect(html).toContain("② 作成順");
      expect(html).not.toContain("② 更新順");
      expect(html).not.toContain("🔮 仮説② の根拠");
      // 起票 2026-10-28 + 44.5 日 = 2026-12-11、観測 2026-11-08 から 33.5 日後
      expect(html).toContain("<strong>2026-12-11</strong>");
      expect(html).toContain("（約 33.5 日後）");
      expect(html).toContain("75%点の日数でマージされる場合");
      expect(html).toContain("起票から 11 日 / 通算所要日数の中央値 44.5 日（25%）");
      expect(html).toContain('class="progress-bar"');
      expect(html).toContain('aria-label="統合処理バンドによる着地予想タイムライン"');
      // 順位消化の注意（更新の入れ替わりを含む）
      expect(html).toContain("実際の消化より速く出ることがあります");
      // 予想パネルは、上部の統計カードより前に出す
      expect(html.indexOf("着地予測（統合処理バンド）")).toBeLessThan(
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
      expect(html).toContain("② 作成順");
      expect(html).toContain("通算所要日数の統計または基準 PR の起票日時が未記録です");
      expect(html).not.toContain('class="progress-bar"');
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
    expect(flow).toContain("健康的大底（最古健康PR）");
    expect(flow).toContain("後続の準備完了 PR");
    expect(flow).toContain("CI・検証通過済みの健康体");
    expect(flow).not.toContain("CI 通過待ち含む");
    expect(html).toContain("🚧 例外・特殊境界（真の大底・特急レーン）");
    expect(html).not.toContain("特急・大底・遭難");
    expect(html).toContain("⚡ 特急レーン＝基準 PR 起票後に作成されマージ済みの最新更新 5 件");
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
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 30,
          OpenCount: 15,
          MergedCount: 15,
          MedianCreatedAt: "2026-10-03T12:00:00Z",
          LagDays: 35,
        },
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
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 32,
          OpenCount: 16,
          MergedCount: 16,
          MedianCreatedAt: "2026-10-04T12:00:00Z",
          LagDays: 35,
        },
      }),
    ];
    writeFileSync(join(dataDir, "depths-history.jsonl"), depthsLines.join("\n"), "utf-8");

    try {
      const { htmlPath } = buildDashboard({ dataDir, outputDir });
      const html = readFileSync(htmlPath, "utf-8");

      // 1. 統合処理バンドヒーローカード
      expect(html).toContain("着地予測（統合処理バンド）");
      expect(html).toContain("本命予想（中央値バンド）");
      expect(html).toContain("全体レンジ（前線 〜 正常底）");
      expect(html).toContain("🌱 初回提出者コホート実績（過去 90 日・12 件）");
      expect(html).toContain("生涯マージ1件の初回提出者（手直し・ラベル履歴を含む）");
      expect(html).toContain("P50: 37.5 日 / P75: 39.4 日");
      expect(html).toContain("<strong>56</strong> 件");
      expect(html).toContain(
        "うち初回提出者: <strong>0</strong> 件 / 常連・特急レーン: <strong>56</strong> 件",
      );
      expect(html).toContain("✨ 採用サンプル内で確定した初回提出者の追い越し: 0 件");

      // 2. 統合チャート（2軸）
      expect(html).toContain('aria-label="待ち件数と正常底の推移（統合時系列チャート）"');
      expect(html).toContain("待ち件数"); // 左軸見出し
      expect(html).toContain("正常底の起票経過（日）"); // 右軸見出し
      expect(html).toContain("実質待ち（更新順）");
      expect(html).toContain("累積待ち（作成順）");
      expect(html).toContain("🌱 マージ正常底（初回提出者のみ）起票経過");
      expect(html).toContain("👀 初動前線（主戦場ライン・初回提出者 7日介入中央値）");
      expect(html.match(/<polyline /g)?.length).toBeGreaterThanOrEqual(4);

      // 3. マージ実績統計カードの分離
      expect(html).toContain("🌱 初回提出者コホート実績（生涯マージ1件）");
      expect(html).toContain("採用 12 件");
      expect(html).toContain("👥 全体実績（常連・特急レーンを含む全サンプル）");

      // 4. 2×2 待機ライン比較マトリクス ＆ 共通トグル
      expect(html).toContain("🧭 待機ライン 2×2 マトリクス（フェーズ × レンジ）");
      expect(html).toContain("🚀 マージ前線（直近マージ実績・早ければ）");
      expect(html).toContain("⚓ マージ正常底（健康的大底・遅くとも）");
      expect(html).toContain('data-matrix-filter="all"');
      expect(html).toContain('data-matrix-filter="first-timer"');
      expect(html).toContain("<th>コミット数</th>");
      expect(html).toContain("<td>3</td>"); // #440002 の CommitCount
      expect(html).toContain("<td>-</td>"); // #440003 (旧データ互換)

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
        if (searchQuery.includes("sort:created-asc") || searchQuery.includes("sort:updated-asc")) {
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
      // Search API で取得された CONTRIBUTOR の行がマージ前線に表示され、初回提出者バッジは付かないこと
      expect(html).toContain("550001");
      expect(html).not.toContain(">🌱 初回提出者<");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test.each([
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount>=1 の隠れ常連には初回提出者バッジが付かない",
      association: "NONE",
      mergedCount: 2,
      expectFirstTimerBadge: false,
    },
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount=0 の初回提出者には初回提出者バッジが付く",
      association: "NONE",
      mergedCount: 0,
      expectFirstTimerBadge: true,
    },
    {
      label:
        "AuthorAssociation=NONE かつ AuthorMergedCount 未設定（旧データ）には初回提出者バッジが付かない",
      association: "NONE",
      mergedCount: undefined,
      expectFirstTimerBadge: false,
    },
    {
      label: "AuthorAssociation=CONTRIBUTOR には初回提出者バッジが付かない",
      association: "CONTRIBUTOR",
      mergedCount: undefined,
      expectFirstTimerBadge: false,
    },
  ])(
    "マージ正常底（健康的大底）初回提出者バッジ判定と起票日時順統一: $label",
    ({ association, mergedCount, expectFirstTimerBadge }) => {
      const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-repeater-badge-"));
      const dataDir = join(tempDir, "data");
      const outputDir = join(tempDir, "site");
      mkdirSync(dataDir, { recursive: true });

      const dummyDepths = {
        Timestamp: "2026-11-08T12:00:00Z",
        TimestampJst: "2026-11-08 21:00:00",
        HealthyBottom: [
          {
            Number: 551001,
            Title: "Healthy Candidate",
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

        const mergeBottomSection = html
          .split("⚓ マージ正常底（健康的大底・遅くとも）")[1]
          .split("🚧 例外・特殊境界（真の大底・特急レーン）")[0];
        const mergeBottomAll = mergeBottomSection.split('data-matrix-view="first-timer"')[0];

        // 全体ビューは「起票からの経過」（38 日）で初回提出者バッジを判定
        expect(mergeBottomAll).toContain("<th>起票からの経過</th>");
        expect(mergeBottomAll).toContain("<td>38 日</td>");
        if (expectFirstTimerBadge) {
          expect(mergeBottomAll).toContain(">🌱 初回提出者<");
        } else {
          expect(mergeBottomAll).not.toContain(">🌱 初回提出者<");
        }

        // マージ正常底（初回提出者ビュー）も「起票からの経過」（36 日）であり、更新からの経過（1 日）ではない
        expect(mergeBottomSection).toContain("<th>起票からの経過</th>");
        expect(mergeBottomSection).not.toContain("<th>更新からの経過</th>");
        expect(mergeBottomSection).toContain("<td>36 日</td>");
        expect(mergeBottomSection).not.toContain("<td>1 日</td>");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  test("renderOvertakeSection: 未観測・旧形式・未判定ありのフォールバックが安全に処理される", () => {
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
    expect(html).not.toContain("🏃 追い越しの比較（採用サンプル内）");
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
    expect(html).toContain("<strong>15</strong> 件");
    expect(html).toContain("初回/常連の内訳は未分類（旧データ）");
    expect(html).not.toContain("常連・特急レーン: <strong>15</strong> 件"); // 勝手に常連に計上しない
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
      "うち初回提出者: <strong>0</strong> 件 / 常連・特急レーン: <strong>13</strong> 件 / 未判定: <strong>7</strong> 件",
    );
    expect(html).not.toContain("採用サンプル内で確定した初回提出者の追い越し: 0 件");
    expect(html).not.toContain("完全な作成順で進行中");

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("統合ヒーロー & renderFirstTimerCohortBlock: FirstTimerLookbackDays が集計期間表示に反映される", () => {
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
    expect(html).toContain("過去 90 日・8 件");
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
    expect(html).toContain("過去 45 日・4 件");
    expect(html).toContain("過去 45 日間・採用 4 件");

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("統合ヒーロー: FirstTimerTurnMedianDays と FirstTimerTurnP75Days が設定されている場合に最終コミット後 (Turn) が出力される", () => {
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
    expect(html).toContain(
      "最終コミット後 (Turn): <strong>5.5</strong> 日 / P75: <strong>8.2</strong> 日",
    );

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("Issue #81: 集計期間（90日/30日/7日）・母集団・上限・初期健康体・TotalLifetimeDays=0のフォールバックを正しく扱う", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-issue-81-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        TargetPr: 123456,
        LookbackDays: 30,
        FirstTimerLookbackDays: 90,
        SampleCount: 142,
        SkippedCount: 4,
        TotalLifetimeDays: 0,
        WaitDays: 12,
        TurnLatencyDays: 0,
        FirstTimerMedianDays: 37.0,
        FirstTimerP75Days: 39.0,
        FirstTimerSampleCount: 8,
        Comparison: {
          LaterCreated: 5,
          EarlierCreated: 10,
          LaterReady: 2,
          FirstTimerLaterCreated: 0,
          RepeatOrExpressLaterCreated: 5,
          UnknownLaterCreated: 0,
        },
      }),
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      // TotalLifetimeDays=0 のとき WaitDays=12 に誤フォールバックしないこと
      expect(html).toContain("基準 PR 現在: 0 日");
      expect(html).not.toContain("基準 PR 現在: 12 日");

      // 追い越し分離内訳の 30 日全体サンプル表記
      expect(html).toContain("直近 30 日間の全体採用サンプル（142 件）内で");

      // KPI カード 4 見出し、用語統一、仮説②削除済み
      expect(html).toContain("準備完了後の待機 (Ready / 通算 / 手番)");
      expect(html).toContain("健康的大底（最古健康PR）");
      expect(html).not.toContain("現在の消化前線");
      expect(html).not.toContain("<th>消化前線 PR</th>");
      expect(html).toContain("直近最大 120 観測点を表示");
      expect(html).toContain("比較対象は直近約 7 日間 / 168 時間窓基準");
      expect(html).toContain("除外件数は、タイムライン上で Ready 条件");
      expect(html).toContain("生涯マージ1件の初回提出者（手直し・ラベル履歴を含む）");
      expect(html).not.toContain("🔮 仮説② の根拠");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("非既定の LookbackDays (14) / FirstTimerLookbackDays (60) でも仮説③と実績統計・初回提出者欄の表示期間が矛盾しない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-lookback-custom-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-08T00:00:00Z",
        TargetPr: 123456,
        LookbackDays: 14,
        FirstTimerLookbackDays: 60,
        SampleCount: 55,
        SkippedCount: 2,
        TotalMedianDays: 18,
        TotalP75Days: 25,
        FirstTimerMedianDays: 32,
        FirstTimerP75Days: 40,
        FirstTimerSampleCount: 5,
        Comparison: {
          LaterCreated: 3,
          EarlierCreated: 4,
          LaterReady: 1,
          FirstTimerLaterCreated: 0,
          RepeatOrExpressLaterCreated: 3,
          UnknownLaterCreated: 0,
        },
      }),
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      expect(html).toContain("過去 60 日・5 件");
      expect(html).toContain("過去 60 日間・採用 5 件");
      expect(html).toContain("直近 14 日間の全体採用サンプル（55 件）内で");
      expect(html).toContain("マージ実績の所要日数統計 (直近 14 日間");
      expect(html).toContain("直近（14日間）の全体マージ実績（常連・特急含む）");
      expect(html).toContain("上部の初回提出者60日コホート統計とは母集団が異なります");
      expect(html).not.toContain("直近（30日間）の全体マージ実績");
      expect(html).not.toContain("上部の初回提出者90日コホート統計とは母集団が異なります");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("主戦場ライン方式（7日初回介入コホート中央値）・内訳テーブル・初回レビュー到達予想・時系列チャートを描画する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-intervention-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-15T00:00:00Z",
        TimestampJst: "2026-11-15 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: 464302,
        PrTitle: "Target Package",
        ActiveAhead: 100,
        TotalAhead: 150,
        Behind: 50,
      }),
      "utf-8",
    );

    const makeRow = (
      num: number,
      createdAt: string,
      updatedAt: string,
      thirdPartyAssignees: string[],
    ) => ({
      PR: `#${num}`,
      Number: num,
      作成日時: createdAt.slice(0, 16).replace("T", " "),
      更新日時: updatedAt.slice(0, 16).replace("T", " "),
      CreatedAt: createdAt,
      UpdatedAt: updatedAt,
      タイトル: `PR ${num}`,
      Title: `PR ${num}`,
      Url: `https://github.com/microsoft/winget-pkgs/pull/${num}`,
      Author: `author-${num}`,
      AuthorAssociation: "NONE",
      CommitCount: 1,
      ThirdPartyAssignees: thirdPartyAssignees,
    });

    const latestDepths = {
      DepthsVersion: CURRENT_DEPTHS_VERSION,
      Timestamp: "2026-11-15T00:00:00Z",
      TimestampJst: "2026-11-15 09:00:00",
      Repository: "microsoft/winget-pkgs",
      TargetPr: {
        Number: 464302,
        Title: "Target Package",
        Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
        CreatedAt: "2026-11-05T00:00:00Z",
        CreatedAtJst: "2026-11-05 09:00",
        UpdatedAt: "2026-11-05T00:00:00Z",
        Author: "scottlz0310",
        ThirdPartyAssignees: [],
        Intervention: {
          Intervened: false,
          ThirdPartyAssignees: [],
          HumanReviewCount: 0,
          ManualCommentCount: 0,
        },
      },
      HealthyBottom: [],
      AbsoluteBottom: [],
      StaleBottom: [
        makeRow(440001, "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z", []),
        makeRow(440002, "2026-10-22T00:00:00Z", "2026-10-22T00:00:00Z", ["stephengillie"]),
      ],
      FirstTimerBottom: [
        makeRow(440003, "2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z", []),
        makeRow(440004, "2026-10-24T00:00:00Z", "2026-10-25T00:00:00Z", ["stephengillie"]),
      ],
      UnreviewedBottom: [makeRow(441002, "2026-10-27T00:00:00Z", "2026-10-27T00:00:00Z", [])],
      FirstReviewFrontier: {
        Mode: "cohort-median-7d",
        WindowDays: 7,
        CohortCount: 12,
        OpenCount: 5,
        MergedCount: 7,
        MedianCreatedAt: "2026-10-27T00:00:00Z",
        LagDays: 19,
        OldestCreatedAt: "2026-10-15T00:00:00Z",
        NewestCreatedAt: "2026-11-01T00:00:00Z",
        Items: [
          {
            Number: 441001,
            Title: "New package: Vendor.App version 1.0.0",
            Url: "https://github.com/microsoft/winget-pkgs/pull/441001",
            State: "MERGED",
            Author: "ft-1",
            CommitCount: 1,
            CreatedAt: "2026-10-21T00:00:00Z",
            FirstHumanInterventionAt: "2026-11-14T10:00:00Z",
            InterventionKind: "review",
            InterventionActor: "matteozanettii",
            MergedAt: "2026-11-14T10:05:00Z",
          },
          {
            Number: 441003,
            Title: "New version: Another.Pkg version 2.1.0",
            Url: "https://github.com/microsoft/winget-pkgs/pull/441003",
            State: "OPEN",
            Author: "ft-2",
            CommitCount: 2,
            CreatedAt: "2026-10-22T00:00:00Z",
            FirstHumanInterventionAt: "2026-11-13T05:00:00Z",
            InterventionKind: "comment",
            InterventionActor: "stephengillie",
          },
        ],
      },
      ExpressLane: [],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(latestDepths), "utf-8");

    // v3 履歴 (UnreviewedBottom) は混入させず、v4 主戦場ラインの 24 時間進行 (2026-10-25 -> 2026-10-27 => 速度 2 日/日、残り 9 日 / 2 = 4.5 日後) で算出
    const historyLines = [
      {
        DepthsVersion: 3,
        Timestamp: "2026-11-13T00:00:00Z",
        TimestampJst: "2026-11-13 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: latestDepths.TargetPr,
        HealthyBottom: [],
        AbsoluteBottom: [],
        StaleBottom: latestDepths.StaleBottom,
        UnreviewedBottom: [makeRow(440999, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", [])],
        ExpressLane: [],
      },
      {
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-14T00:00:00Z",
        TimestampJst: "2026-11-14 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: latestDepths.TargetPr,
        HealthyBottom: [],
        AbsoluteBottom: [],
        StaleBottom: latestDepths.StaleBottom,
        UnreviewedBottom: latestDepths.UnreviewedBottom,
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 10,
          OpenCount: 4,
          MergedCount: 6,
          MedianCreatedAt: "2026-10-25T00:00:00Z",
          LagDays: 20,
        },
        ExpressLane: [],
      },
      latestDepths,
    ];
    writeFileSync(
      join(dataDir, "depths-history.jsonl"),
      `${historyLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      // 統合ヒーローカード内の初動前線現在位置（外挿廃止・定常換算・初回提出者明記）
      expect(html).toContain("👀 初動前線（主戦場ライン・初回提出者 7日介入中央値）");
      expect(html).toContain("自PRと差 9 日（定常 1.0 日/日換算:");
      expect(html).toContain("7日初回介入 12件 [Open 5 / Merged 7]");

      // 統合時系列チャートに初動前線系列
      expect(html).toContain("👀 初動前線（主戦場ライン・初回提出者 7日介入中央値）");

      // 2×2 マトリクス内のマージ正常底で第三者アサイン済みバッジ
      const mergeBottomSection = html
        .split("⚓ マージ正常底（健康的大底・遅くとも）")[1]
        .split("🚧 例外・特殊境界（真の大底・特急レーン）")[0];
      expect(mergeBottomSection).toContain("アサイン済: stephengillie");

      // 2×2 マトリクス内の初動前線（主戦場ライン）・初動正常底（未レビュー最古）
      expect(html).toContain("🧭 待機ライン 2×2 マトリクス（フェーズ × レンジ）");
      expect(html).not.toContain("（(");
      expect(html).toContain("🎯 初動前線（主戦場ライン・早ければ）");
      expect(html).toContain("計 12 件 (Open 5 / Merged 7)");
      expect(html).toContain("直近介入順 30 件表示");
      const mainstreamCardHtml = html
        .split("🎯 初動前線（主戦場ライン・早ければ）")[1]
        .split("🟦 初動正常底（未レビュー最古・遅くとも）")[0];
      expect(mainstreamCardHtml).toContain("<th>PR / パッケージ</th>");
      expect(mainstreamCardHtml).not.toContain("<th>タイトル</th>");
      expect(mainstreamCardHtml).toContain('title="New package: Vendor.App version 1.0.0"');
      expect(mainstreamCardHtml).toContain("Vendor.App version 1.0.0");
      expect(mainstreamCardHtml).toContain('title="New version: Another.Pkg version 2.1.0"');
      expect(mainstreamCardHtml).toContain("Another.Pkg version 2.1.0");
      expect(html).toContain("🟦 初動正常底（未レビュー最古・遅くとも）");
      expect(html).toContain("MERGED");
      expect(html).toContain("OPEN");
      expect(html).toContain("レビュー: matteozanettii");
      expect(html).toContain("コメント: stephengillie");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("基準 PR 自身がコメント／レビュー等で介入済みの場合は初回レビュー到達済みとして表示し、旧 Depthsv2 データとも後方互換を保つ", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-target-intervened-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-depths.json"),
      JSON.stringify({
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-15T00:00:00Z",
        TimestampJst: "2026-11-15 09:00:00",
        TargetPr: {
          Number: 464302,
          Title: "Target Package",
          Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
          CreatedAt: "2026-11-05T00:00:00Z",
          CreatedAtJst: "2026-11-05 09:00",
          UpdatedAt: "2026-11-05T00:00:00Z",
          Intervention: {
            Intervened: true,
            ThirdPartyAssignees: [],
            HumanReviewCount: 0,
            ManualCommentCount: 1,
            PrimaryBadge: {
              Kind: "comment",
              Actor: "stephengillie",
              Label: "コメント済: stephengillie",
            },
          },
        },
        StaleBottom: [
          {
            Number: 440001,
            Title: "Legacy Row Without ThirdPartyAssignees",
            Url: "https://github.com/microsoft/winget-pkgs/pull/440001",
            CreatedAt: "2026-10-20T00:00:00Z",
            UpdatedAt: "2026-10-21T00:00:00Z",
          },
        ],
      }),
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      expect(html).toContain("基準PR介入済み");
      expect(html).toContain("（コメント済: stephengillie）");
      expect(html).toContain(
        "未レビュー最古のデータはまだありません（次回の定期観測から記録されます）。",
      );
      expect(html).toContain(
        "主戦場ラインのデータはまだありません（次回の定期観測から記録されます）。",
      );
      expect(html).not.toContain("アサイン済: undefined");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("主戦場ライン コホートが 0 件時はデータ不足として安全にフォールバックし、起票日差 <= 0 は到達済みと明示する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-mainstream-fallback-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const targetPr = {
      Number: 464302,
      Title: "Target Package",
      Url: "https://github.com/microsoft/winget-pkgs/pull/464302",
      CreatedAt: "2026-10-10T00:00:00Z",
      CreatedAtJst: "2026-10-10 09:00",
      UpdatedAt: "2026-10-10T00:00:00Z",
      Intervention: {
        Intervened: false,
        ThirdPartyAssignees: [],
        HumanReviewCount: 0,
        ManualCommentCount: 0,
      },
    };

    try {
      // ケース1: 0件フォールバック（NaN や例外なし）
      const zeroSnapshot = {
        DepthsVersion: CURRENT_DEPTHS_VERSION,
        Timestamp: "2026-11-15T00:00:00Z",
        TimestampJst: "2026-11-15 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: targetPr,
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 0,
          OpenCount: 0,
          MergedCount: 0,
          MedianCreatedAt: null,
          LagDays: null,
          Items: [],
        },
      };
      writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(zeroSnapshot), "utf-8");
      writeFileSync(
        join(dataDir, "depths-history.jsonl"),
        `${JSON.stringify(zeroSnapshot)}\n`,
        "utf-8",
      );

      const zeroHtml = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(zeroHtml).toContain("データ不足");
      expect(zeroHtml).not.toContain("NaN");

      // ケース2: 主戦場ライン中央値が基準 PR 起票日以降（gapDays <= 0）
      const reachedSnapshot = {
        ...zeroSnapshot,
        FirstReviewFrontier: {
          Mode: "cohort-median-7d",
          WindowDays: 7,
          CohortCount: 5,
          OpenCount: 2,
          MergedCount: 3,
          MedianCreatedAt: "2026-10-12T00:00:00Z",
          LagDays: 34,
          Items: [],
        },
      };
      writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(reachedSnapshot), "utf-8");
      writeFileSync(
        join(dataDir, "depths-history.jsonl"),
        `${JSON.stringify(reachedSnapshot)}\n`,
        "utf-8",
      );

      const reachedHtml = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(reachedHtml).toContain("基準 PR の起票日ラインに到達済み");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("走査上限到達（UnreviewedTruncated）時は未確定として表示し該当なしと断定しない", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-intervention-truncated-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    const baseDepths = {
      DepthsVersion: CURRENT_DEPTHS_VERSION,
      Timestamp: "2026-11-15T00:00:00Z",
      TimestampJst: "2026-11-15 09:00:00",
      TargetPr: null,
      HealthyBottom: [],
      AbsoluteBottom: [],
      StaleBottom: [],
      UnreviewedBottom: [] as unknown[],
      UnreviewedTruncated: true,
      ExpressLane: [],
    };
    writeFileSync(join(dataDir, "latest-depths.json"), JSON.stringify(baseDepths), "utf-8");

    try {
      const htmlEmpty = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(htmlEmpty).toContain("探索上限到達・未確定");
      expect(htmlEmpty).toContain(
        "走査上限に到達したため探索を打ち切りました（未走査の PR が残っており、対象 PR の有無は未確定です）。",
      );
      expect(htmlEmpty).not.toContain("現在、完全未着手の健康な待機 PR はありません。");

      writeFileSync(
        join(dataDir, "latest-depths.json"),
        JSON.stringify({
          ...baseDepths,
          UnreviewedBottom: [
            {
              Number: 442001,
              Title: "Unreviewed PR",
              Url: "https://github.com/microsoft/winget-pkgs/pull/442001",
              CreatedAt: "2026-10-20T00:00:00Z",
              UpdatedAt: "2026-10-21T00:00:00Z",
              Author: "user1",
              CommitCount: 1,
            },
          ],
        }),
        "utf-8",
      );
      const htmlPartial = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(htmlPartial).toContain("上位 1 件（上限到達・一部未完）");
      expect(htmlPartial).toContain(
        "※ 走査上限に到達したため途中で打ち切りました（未走査の PR が残っています）。",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("merged-samples.jsonl から初回提出者 最速マージランキング（TOP 10）を比較サンプルセクション直前に描画する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-first-timer-ranking-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    writeFileSync(
      join(dataDir, "latest-progress.json"),
      JSON.stringify({
        Timestamp: "2026-11-17T00:00:00Z",
        TimestampJst: "2026-11-17 09:00:00",
        Repository: "microsoft/winget-pkgs",
        TargetPr: 464302,
        PrTitle: "Target Package",
        SampleCount: 1,
        Samples: [
          {
            Number: 9001,
            Relation: "older",
            CommitCount: 1,
            TurnDays: 1.0,
            TotalDays: 1.0,
            ReadyDays: 1.0,
            LatestCommittedDate: "2026-11-10T00:00:00Z",
            MergedAt: "2026-11-11T00:00:00Z",
            IsFirstTimer: false,
          },
        ],
      }),
      "utf-8",
    );

    const makeCacheSample = (
      num: number,
      totalDays: number,
      isFirstTimer: boolean,
      title = `New package: Pkg.${num}`,
      overrides: Record<string, unknown> = {},
    ) => ({
      Type: "sample",
      Number: num,
      Title: title,
      CreatedAt: "2026-10-01T00:00:00Z",
      LatestCommittedDate: "2026-10-01T01:00:00.000Z",
      CommitCount: 2,
      ReadyAt: "2026-10-01T02:00:00.000Z",
      MergedAt: "2026-10-02T00:00:00.000Z",
      TotalDays: totalDays,
      TurnDays: Math.max(0.1, totalDays - 0.1),
      ReadyDays: Math.max(0.5, totalDays - 0.2),
      Author: `author-${num}`,
      AuthorType: "User",
      AuthorAssociation: "CONTRIBUTOR",
      IsFirstTimer: isFirstTimer,
      FirstTimerVersion: 7,
      ...overrides,
    });

    // 11 件の初回提出者 + 常連 + 後続行上書き + 不純物（v4/v6旧版 / ReadyDays<0.5 / 90日窓外 / MEMBER / Bot）
    const cacheLines = [
      makeCacheSample(410001, 0.8, true, "Should be excluded later"),
      makeCacheSample(410002, 50.0, false, "Old false row"),
      makeCacheSample(410003, 0.8, false, "Regular contributor"),
      makeCacheSample(410004, 0.04, true, "v4 zombie cache", { FirstTimerVersion: 4 }),
      makeCacheSample(410009, 0.05, true, "v6 legacy cache", { FirstTimerVersion: 6 }),
      makeCacheSample(410005, 0.6, true, "Bypass ready < 0.5", { ReadyDays: 0.1 }),
      makeCacheSample(410006, 0.7, true, "Too old createdAt (>90d)", {
        CreatedAt: "2026-07-01T00:00:00Z",
      }),
      makeCacheSample(410007, 0.6, true, "Privileged member", { AuthorAssociation: "MEMBER" }),
      makeCacheSample(410008, 0.6, true, "Bot account", { AuthorType: "Bot" }),
      ...Array.from({ length: 11 }, (_, idx) => makeCacheSample(420000 + idx, idx + 1.0, true)),
      makeCacheSample(410001, 0.8, false, "Disqualified in later line"),
      makeCacheSample(410002, 0.8, true, "Fastest updated entry", {
        CommitCount: 3,
        ReadyDays: 0.7,
      }),
    ];
    writeFileSync(
      join(dataDir, "merged-samples.jsonl"),
      `${cacheLines.map((l) => JSON.stringify(l)).join("\n")}\n`,
      "utf-8",
    );

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");

      const rankingPos = html.indexOf(
        "🏆 初回提出者 最速マージランキング（直近 90 日起票 TOP 10）",
      );
      const samplesPos = html.indexOf("🧪 比較に使ったサンプル");
      expect(rankingPos).toBeGreaterThan(-1);
      expect(samplesPos).toBeGreaterThan(rankingPos);

      const rankingSection = html.slice(rankingPos, samplesPos);
      // 該当全件数 = 11 + 1 (#410002) = 12 件のうち TOP 10
      expect(rankingSection).toContain("全 12 件");
      expect(rankingSection).toContain("上位 10 件");
      expect(rankingSection).toContain("成立後 0.5 日以上・v7 以上・特権ロール/Bot 除外");
      expect(rankingSection).not.toContain("v6 legacy cache");
      expect(rankingSection).toContain("<th>順位</th>");
      expect(rankingSection).toContain("<th>PR 番号</th>");
      expect(rankingSection).toContain("<th>コミット数</th>");
      expect(rankingSection).toContain("<th>通算日数</th>");
      expect(rankingSection).toContain("<th>最終コミット後</th>");
      expect(rankingSection).toContain("<th>成立後</th>");
      expect(rankingSection).toContain("<th>起票日時 (JST)</th>");
      expect(rankingSection).toContain("<th>マージ日時 (JST)</th>");
      expect(rankingSection).toContain("<th>タイトル</th>");

      expect(rankingSection).toContain(
        'href="https://github.com/microsoft/winget-pkgs/pull/410002"',
      );
      expect(rankingSection).toContain("Fastest updated entry");
      expect(rankingSection).toContain("0.8 日");
      expect(rankingSection).toContain("2026-10-01(木) 09:00");
      expect(rankingSection).toContain("2026-10-02(金) 09:00");
      // 後続行で除外された #410001、常連 #410003、不純物 #410004〜#410008、11位以下 (#420009, #420010) は含まれない
      for (const excluded of [
        410001, 410003, 410004, 410005, 410006, 410007, 410008, 420009, 420010,
      ]) {
        expect(rankingSection).not.toContain(`#${excluded}`);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("初回提出者サンプルが 0 件または merged-samples.jsonl 未存在時は代替メッセージを表示する", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "winget-obs-first-timer-ranking-empty-"));
    const dataDir = join(tempDir, "data");
    const outputDir = join(tempDir, "site");
    mkdirSync(dataDir, { recursive: true });

    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("🏆 初回提出者 最速マージランキング（直近 90 日起票 TOP 10）");
      expect(html).toContain("対象の初回提出者サンプルがまだありません");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
