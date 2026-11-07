import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboard } from "../scripts/build-pages";
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
      expect(html).toContain("+50"); // 前線番号増加（進行）

      // 新指標: Velocity & ETA（24時間で50件消化 = 日速50件、残り100件で約2日後）
      expect(html).toContain("到着予測 (ETA) &amp; 消化速度");
      expect(html).toContain("約 2");
      expect(html).toContain("日後");
      expect(html).toContain("50 件/日");

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

      expect(html).toContain("遭難の底（順番待ちの先頭）");
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

  test("定常待ち時間モデルと観測速度モデルの予想を並べて表示する", () => {
    // 先頭が 24 時間で 1 日分進む（1 日/日）。基準 PR との差は 10 日 → 約 10 日後
    const history = [
      snapshot("2026-11-07T00:00:00Z", 10, "2026-10-09T00:00:00Z"),
      snapshot("2026-11-08T00:00:00Z", 10, "2026-10-10T00:00:00Z"),
    ]
      .map((s) => JSON.stringify(s))
      .join("\n");
    const { tempDir, dataDir, outputDir } = setup(history);
    try {
      const html = readFileSync(buildDashboard({ dataDir, outputDir }).htmlPath, "utf-8");
      expect(html).toContain("マージ時期の予想");
      expect(html).toContain("定常待ち時間モデル");
      expect(html).toContain("観測速度モデル");
      expect(html).toContain("約 10 <span");
      expect(html).toContain("先頭の進み: <strong>1</strong> 日/日");
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

  test("サンプルがないときは追い越し・サンプル一覧を出さず、除外件数だけ示す", () => {
    const html = build({ samples: [], skipped: 4 });

    expect(html).toContain("採用 0 件・除外 4 件");
    expect(html).not.toContain("追い越しの比較");
    expect(html).not.toContain("比較に使ったサンプル");
    expect(html).toContain("直前のライバル PR");
  });
});
