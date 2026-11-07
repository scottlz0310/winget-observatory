import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("sync-dropbox CLI credentials validation", () => {
  const scriptPath = resolve(__dirname, "../scripts/sync-dropbox.ts");

  test("資格情報が未設定で --allow-skip がない場合は非ゼロ終了 (exit 1) すること", async () => {
    const proc = Bun.spawn(["bun", "run", scriptPath, "--direction", "upload"], {
      env: {
        ...process.env,
        DROPBOX_APP_KEY: "",
        DROPBOX_APP_SECRET: "",
        DROPBOX_REFRESH_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain(
      "DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN の環境変数を設定してください",
    );
  });

  test("資格情報が未設定でも --allow-skip が指定された場合は正常終了 (exit 0) すること", async () => {
    const proc = Bun.spawn(["bun", "run", scriptPath, "--direction", "upload", "--allow-skip"], {
      env: {
        ...process.env,
        DROPBOX_APP_KEY: "",
        DROPBOX_APP_SECRET: "",
        DROPBOX_REFRESH_TOKEN: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("同期をスキップします");
  });
});
