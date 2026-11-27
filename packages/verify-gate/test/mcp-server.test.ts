import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runCli } from "../src/cli";
import {
  handleJsonRpcMessage,
  MCP_SKILLS_EXTENSION_ID,
  runStdioMcpServer,
} from "../src/mcp-server";
import { buildSyntheticPe } from "./pe-inspector.test";

describe("MCP STDIO server (io.modelcontextprotocol/skills) & CLI", () => {
  test("initialize で io.modelcontextprotocol/skills (directoryRead: true) を宣言し、極小ツール説明を返す", async () => {
    const initRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {} },
    });
    expect(initRes?.error).toBeUndefined();
    const initResult = initRes?.result as {
      protocolVersion: string;
      capabilities: {
        tools: Record<string, unknown>;
        resources: Record<string, unknown>;
        extensions: Record<string, { directoryRead?: boolean }>;
      };
      serverInfo: { name: string; version: string };
    };
    expect(initResult.protocolVersion).toBe("2025-11-25");
    expect(initResult.capabilities.extensions[MCP_SKILLS_EXTENSION_ID]).toEqual({
      directoryRead: true,
    });
    expect(initResult.serverInfo.name).toBe("winget-verify-gate");
    expect(initResult.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);

    // CLI --version / -v が MCP_SERVER_VERSION と一致するバージョンを返すこと
    const verOut: string[] = [];
    expect(
      await runCli(["--version"], {
        io: { stdout: (t) => verOut.push(t), stderr: () => {} },
      }),
    ).toBe(0);
    expect(verOut[0]).toBe(`winget-verify-gate ${initResult.serverInfo.version}`);

    // 通知には応答しない
    const notifRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifRes).toBeNull();

    // tools/list: ツール説明が極小（100 文字以内）に抑えられていること
    const toolsRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(toolsRes).not.toBeNull();
    const tools = (
      (toolsRes?.result ?? {}) as { tools: Array<{ name: string; description: string }> }
    ).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "verify_manifest",
      "verify_binary",
      "prepare_sandbox",
      "evaluate_sandbox",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeLessThanOrEqual(100);
    }
  });

  test("skills/list, skills/get, resources/list, resources/read, resources/directory/read が SEP-2640 契約どおり動作する", async () => {
    const listRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "skills/list",
    });
    const skills = ((listRes?.result ?? {}) as { skills: Array<{ uri: string }> }).skills;
    expect(skills).toHaveLength(1);
    const skillUri = skills[0].uri;
    expect(skillUri).toBe("skill://winget-verify-gate/SKILL.md");

    const getRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "skills/get",
      params: { uri: skillUri },
    });
    const gotSkill = ((getRes?.result ?? {}) as { skill?: { uri: string; resources: unknown[] } })
      .skill;
    expect(gotSkill?.uri).toBe(skillUri);
    expect(gotSkill?.resources).toHaveLength(3);

    const readRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 12,
      method: "resources/read",
      params: { uri: "skill://winget-verify-gate/templates/pr-template.md" },
    });
    const contents = ((readRes?.result ?? {}) as { contents: Array<{ text: string }> }).contents;
    expect(contents[0]?.text).toContain("Reviewer Notes");

    const dirRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 13,
      method: "resources/directory/read",
      params: { uri: "skill://winget-verify-gate" },
    });
    const dirResources = (
      (dirRes?.result ?? {}) as {
        resources: Array<{ uri: string; name: string; mimeType: string }>;
      }
    ).resources;
    expect(dirResources).toHaveLength(3);
    const refsEntry = dirResources.find((r) => r.name === "references");
    expect(refsEntry).toEqual({
      uri: "skill://winget-verify-gate/references",
      name: "references",
      mimeType: "inode/directory",
    });

    const subDirRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 130,
      method: "resources/directory/read",
      params: { uri: refsEntry?.uri },
    });
    const subResources = (
      (subDirRes?.result ?? {}) as { resources: Array<{ uri: string; name: string }> }
    ).resources;
    expect(subResources.map((r) => r.name)).toEqual(["submission-guide.md"]);

    const fileAsDirRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 131,
      method: "resources/directory/read",
      params: { uri: skillUri },
    });
    expect(fileAsDirRes?.error?.code).toBe(-32602);

    const missingDirRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 132,
      method: "resources/directory/read",
      params: { uri: "skill://winget-verify-gate/missing" },
    });
    expect(missingDirRes?.error?.code).toBe(-32602);

    const notFoundRes = await handleJsonRpcMessage({
      jsonrpc: "2.0",
      id: 14,
      method: "skills/get",
      params: { uri: "skill://nonexistent/SKILL.md" },
    });
    expect(notFoundRes?.error?.code).toBe(-32602);
  });

  test("tools/call で verify_binary と不正パラメータエラーを処理できる", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "vg-mcp-tool-"));
    try {
      const exePath = join(tmpDir, "demo.exe");
      writeFileSync(
        exePath,
        buildSyntheticPe({
          machine: 0x8664,
          pe32Plus: true,
          importedDlls: ["KERNEL32.dll"],
          hasSignature: false,
        }),
      );

      const okRes = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 20,
        method: "tools/call",
        params: {
          name: "verify_binary",
          arguments: { binaryPath: exePath, expectedArchitecture: "x64" },
        },
      });
      const callResult = okRes?.result as {
        isError: boolean;
        structuredContent: { passed: boolean };
      };
      expect(callResult.isError).toBe(false);
      expect(callResult.structuredContent.passed).toBe(true);

      const badArch = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: "verify_binary",
          arguments: { binaryPath: exePath, expectedArchitecture: "mips" },
        },
      });
      expect(badArch?.error?.code).toBe(-32602);

      // resources/list・未知メソッド・verify_manifest のエラー＆正常系
      const resList = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 22,
        method: "resources/list",
      });
      expect(((resList?.result ?? {}) as { resources: unknown[] }).resources).toHaveLength(3);

      const unknownMethod = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 23,
        method: "unknown/method",
      });
      expect(unknownMethod?.error?.code).toBe(-32601);

      const missingDirCall = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 24,
        method: "tools/call",
        params: {
          name: "verify_manifest",
          arguments: { manifestDir: join(tmpDir, "no-such-dir"), offline: true },
        },
      });
      expect(((missingDirCall?.result ?? {}) as { isError: boolean }).isError).toBe(true);

      const badOffline = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 25,
        method: "tools/call",
        params: {
          name: "verify_manifest",
          arguments: { manifestDir: tmpDir, offline: "yes" },
        },
      });
      expect(badOffline?.error?.code).toBe(-32602);

      // CLI の binary / check / エラー系テスト
      const cliOut: string[] = [];
      const cliErr: string[] = [];
      const cliIo = {
        stdout: (t: string) => cliOut.push(t),
        stderr: (t: string) => cliErr.push(t),
      };
      expect(await runCli(["binary", exePath, "--arch", "x64", "--json"], { io: cliIo })).toBe(0);
      expect(JSON.parse(cliOut[0] ?? "{}").passed).toBe(true);
      expect(await runCli(["binary", exePath, "--arch", "arm64"], { io: cliIo })).toBe(1);
      expect(await runCli(["binary", exePath, "--arch", "mips"], { io: cliIo })).toBe(2);
      expect(await runCli(["check", join(tmpDir, "no-such-dir"), "--offline"], { io: cliIo })).toBe(
        2,
      );
      expect(await runCli(["unknown-cmd"], { io: cliIo })).toBe(2);
      expect(cliErr.length).toBeGreaterThanOrEqual(3);

      // 有効なマニフェストに対する CLI check --offline と MCP verify_manifest
      writeFileSync(
        join(tmpDir, "App.yaml"),
        [
          "# yaml-language-server: $schema=https://aka.ms/winget-manifest.singleton.1.12.0.schema.json",
          "PackageIdentifier: Example.App",
          "PackageVersion: 1.0.0",
          "PackageLocale: en-US",
          "Publisher: Example",
          "PackageName: App",
          "License: MIT",
          "LicenseUrl: https://example.com/LICENSE",
          "ShortDescription: Example tool",
          "Installers:",
          "  - Architecture: x64",
          "    InstallerType: portable",
          "    InstallerUrl: https://github.com/example/app/releases/download/v1.0.0/app.exe",
          `    InstallerSha256: ${"B".repeat(64)}`,
          "ManifestType: singleton",
          "ManifestVersion: 1.12.0",
        ].join("\n"),
      );
      expect(
        await runCli(["check", tmpDir, "--binary", exePath, "--offline", "--json"], { io: cliIo }),
      ).toBe(0);
      const mcpCheck = await handleJsonRpcMessage({
        jsonrpc: "2.0",
        id: 26,
        method: "tools/call",
        params: {
          name: "verify_manifest",
          arguments: { manifestDir: tmpDir, binaryPath: exePath, offline: true },
        },
      });
      expect(
        ((mcpCheck?.result ?? {}) as { structuredContent: { passed: boolean } }).structuredContent
          .passed,
      ).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("STDIO パイプ経由で NDJSON 複数リクエストと不正 JSON を処理し、CLI サブコマンドも動作する", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf8")));

    const serverPromise = runStdioMcpServer({}, { input, output });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "skills/get",
        params: { uri: "skill://winget-verify-gate/SKILL.md" },
      })}\n`,
    );
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/directory/read",
        params: { uri: "skill://winget-verify-gate" },
      })}\n`,
    );
    input.write("{broken json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.end();
    await serverPromise;

    const lines = chunks
      .join("")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            jsonrpc: string;
            id: number | null;
            result?: Record<string, unknown>;
            error?: { code: number };
          },
      );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect((lines[1]?.result?.skill as { uri: string } | undefined)?.uri).toBe(
      "skill://winget-verify-gate/SKILL.md",
    );
    expect(
      (lines[2]?.result?.resources as Array<{ uri: string; mimeType: string }> | undefined)?.some(
        (r) =>
          r.uri === "skill://winget-verify-gate/references" && r.mimeType === "inode/directory",
      ),
    ).toBe(true);
    expect(lines[3]?.error?.code).toBe(-32700);

    // CLI skill list / export / help の動作確認
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const io = {
      stdout: (t: string) => stdoutLines.push(t),
      stderr: (t: string) => stderrLines.push(t),
    };
    expect(await runCli(["--help"], { io })).toBe(0);
    expect(await runCli(["skill", "list", "--json"], { io })).toBe(0);
    expect(JSON.parse(stdoutLines[1] ?? "{}").skills).toHaveLength(1);

    const tmpOut = mkdtempSync(join(tmpdir(), "vg-cli-export-"));
    try {
      expect(await runCli(["skill", "export", "--out", tmpOut, "--json"], { io })).toBe(0);
      expect(stderrLines).toEqual([]);
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  });
});
