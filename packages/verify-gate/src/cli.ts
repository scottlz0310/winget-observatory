#!/usr/bin/env bun
import {
  formatGateReportText,
  type GateRunnerDeps,
  runBinaryGate,
  runManifestGate,
} from "./gate-runner";
import { runStdioMcpServer } from "./mcp-server";
import { SkillCatalog } from "./skill-catalog";
import type { PeArchitecture } from "./types";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  stdin?: NodeJS.ReadableStream;
  rawStdout?: NodeJS.WritableStream;
}

const HELP_TEXT = `verify-gate — microsoft/winget-pkgs pre-submission gate (STDIO CLI + MCP)

Usage:
  verify-gate check <manifest-dir> [--binary <path>] [--offline] [--verify-sha256] [--min-manifest-version <ver>] [--json]
  verify-gate binary <pe-path> [--arch x64|x86|arm64] [--json]
  verify-gate mcp
  verify-gate skill list [--json]
  verify-gate skill export --out <dir> [--json]
`;

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} には値が必要です`);
  }
  return value;
}

export async function runCli(
  argv: readonly string[],
  deps: { gateDeps?: GateRunnerDeps; catalog?: SkillCatalog; io?: CliIo } = {},
): Promise<number> {
  const io: CliIo = deps.io ?? {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    stdin: process.stdin,
    rawStdout: process.stdout,
  };

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    io.stdout(HELP_TEXT.trimEnd());
    return 0;
  }

  const command = argv[0];
  try {
    if (command === "check") {
      let manifestDir: string | null = null;
      let binaryPath: string | undefined;
      let offline = false;
      let verifySha256 = false;
      let minManifestVersion: string | undefined;
      let asJson = false;

      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--binary") {
          binaryPath = takeValue(argv, i, "--binary");
          i++;
        } else if (arg === "--offline") {
          offline = true;
        } else if (arg === "--verify-sha256") {
          verifySha256 = true;
        } else if (arg === "--min-manifest-version") {
          minManifestVersion = takeValue(argv, i, "--min-manifest-version");
          i++;
        } else if (arg === "--json") {
          asJson = true;
        } else if (arg.startsWith("-")) {
          throw new Error(`未知のオプションです: ${arg}`);
        } else if (!manifestDir) {
          manifestDir = arg;
        } else {
          throw new Error(`余分な引数です: ${arg}`);
        }
      }
      if (!manifestDir) {
        throw new Error("check には <manifest-dir> の指定が必要です");
      }

      const report = await runManifestGate(
        { manifestDir, binaryPath, offline, verifySha256, minManifestVersion },
        deps.gateDeps,
      );
      io.stdout(asJson ? JSON.stringify(report, null, 2) : formatGateReportText(report));
      return report.passed ? 0 : 1;
    }

    if (command === "binary") {
      let binaryPath: string | null = null;
      let expectedArchitecture: PeArchitecture | undefined;
      let asJson = false;

      for (let i = 1; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--arch") {
          const val = takeValue(argv, i, "--arch");
          if (val !== "x64" && val !== "x86" && val !== "arm64") {
            throw new Error(`--arch は x64 / x86 / arm64 のいずれかを指定してください: ${val}`);
          }
          expectedArchitecture = val;
          i++;
        } else if (arg === "--json") {
          asJson = true;
        } else if (arg.startsWith("-")) {
          throw new Error(`未知のオプションです: ${arg}`);
        } else if (!binaryPath) {
          binaryPath = arg;
        } else {
          throw new Error(`余分な引数です: ${arg}`);
        }
      }
      if (!binaryPath) {
        throw new Error("binary には <pe-path> の指定が必要です");
      }

      const report = runBinaryGate({ binaryPath, expectedArchitecture }, deps.gateDeps);
      io.stdout(asJson ? JSON.stringify(report, null, 2) : formatGateReportText(report));
      return report.passed ? 0 : 1;
    }

    if (command === "mcp") {
      await runStdioMcpServer(
        { catalog: deps.catalog, gateDeps: deps.gateDeps },
        { input: io.stdin, output: io.rawStdout },
      );
      return 0;
    }

    if (command === "skill") {
      const sub = argv[1];
      const catalog = deps.catalog ?? new SkillCatalog();
      if (sub === "list") {
        const asJson = argv.includes("--json");
        const listed = catalog.listSkills();
        if (asJson) {
          io.stdout(JSON.stringify(listed, null, 2));
        } else {
          for (const skill of listed.skills) {
            io.stdout(`${skill.frontmatter.name} (${skill.uri})`);
            io.stdout(`  ${skill.frontmatter.description}`);
            for (const r of skill.resources) {
              io.stdout(`  - ${r.uri} (${r.size} bytes, ${r.digest})`);
            }
          }
        }
        return 0;
      }

      if (sub === "export") {
        let outDir: string | null = null;
        let asJson = false;
        for (let i = 2; i < argv.length; i++) {
          const arg = argv[i];
          if (arg === "--out") {
            outDir = takeValue(argv, i, "--out");
            i++;
          } else if (arg === "--json") {
            asJson = true;
          } else {
            throw new Error(`未知のオプションです: ${arg}`);
          }
        }
        if (!outDir) {
          throw new Error("skill export には --out <dir> の指定が必要です");
        }
        const exported = catalog.exportSkill(outDir);
        if (asJson) {
          io.stdout(JSON.stringify(exported, null, 2));
        } else {
          io.stdout(`Exported skill '${exported.skillName}' to ${exported.outputDir}`);
          for (const f of exported.files) {
            io.stdout(`  - ${f.relativePath} (${f.size} bytes, ${f.digest})`);
          }
        }
        return 0;
      }

      throw new Error(`未知の skill サブコマンドです: ${sub ?? "(未指定)"}`);
    }

    throw new Error(`未知のコマンドです: ${command}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`[verify-gate] Error: ${message}`);
    return 2;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
