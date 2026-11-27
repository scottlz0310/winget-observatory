import { createInterface } from "node:readline";
import {
  type GateRunnerDeps,
  runBinaryGate,
  runManifestGate,
  runSandboxEval,
  runSandboxPrepare,
} from "./gate-runner";
import { SkillCatalog } from "./skill-catalog";
import type { PeArchitecture } from "./types";

export const MCP_SERVER_NAME = "winget-verify-gate";
export const MCP_SERVER_VERSION = "0.2.0";
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpServerDeps {
  catalog?: SkillCatalog;
  gateDeps?: GateRunnerDeps;
}

const MCP_TOOLS = [
  {
    name: "verify_manifest",
    description: "Run winget-pkgs pre-submission checks on a manifest directory.",
    inputSchema: {
      type: "object",
      properties: {
        manifestDir: { type: "string" },
        binaryPath: { type: "string" },
        sandboxResultPath: { type: "string" },
        offline: { type: "boolean" },
        verifySha256: { type: "boolean" },
        minManifestVersion: { type: "string" },
      },
      required: ["manifestDir"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_binary",
    description: "Inspect a Windows PE binary for arch, CRT DLLs, and signature.",
    inputSchema: {
      type: "object",
      properties: {
        binaryPath: { type: "string" },
        expectedArchitecture: { type: "string", enum: ["x64", "x86", "arm64"] },
      },
      required: ["binaryPath"],
      additionalProperties: false,
    },
  },
  {
    name: "prepare_sandbox",
    description: "Generate Windows Sandbox (.wsb and PowerShell) files for manifest testing.",
    inputSchema: {
      type: "object",
      properties: {
        manifestDir: { type: "string" },
        outDir: { type: "string" },
        wingetPkgsRoot: { type: "string" },
        probeCommands: { type: "array", items: { type: "string" } },
        skipUninstall: { type: "boolean" },
        enableVgpu: { type: "boolean" },
      },
      required: ["manifestDir", "outDir"],
      additionalProperties: false,
    },
  },
  {
    name: "evaluate_sandbox",
    description: "Evaluate Windows Sandbox ARP diff and CLI probe results against a manifest.",
    inputSchema: {
      type: "object",
      properties: {
        manifestDir: { type: "string" },
        resultPath: { type: "string" },
      },
      required: ["manifestDir", "resultPath"],
      additionalProperties: false,
    },
  },
] as const;

function makeResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function makeError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function handleJsonRpcMessage(
  rawMessage: unknown,
  deps: McpServerDeps = {},
): Promise<JsonRpcResponse | null> {
  if (typeof rawMessage !== "object" || rawMessage === null || Array.isArray(rawMessage)) {
    return makeError(null, -32600, "Invalid Request");
  }
  const msg = rawMessage as Partial<JsonRpcRequest>;
  const isNotification = msg.id === undefined;
  const id = msg.id ?? null;

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return isNotification ? null : makeError(id, -32600, "Invalid Request");
  }

  // Notifications require no response per JSON-RPC 2.0
  if (isNotification || msg.method.startsWith("notifications/")) {
    return null;
  }

  const params = asRecord(msg.params);
  const catalog = deps.catalog ?? new SkillCatalog();

  switch (msg.method) {
    case "initialize": {
      const requestedProtocol = asNonEmptyString(params.protocolVersion);
      return makeResult(id, {
        protocolVersion: requestedProtocol ?? MCP_DEFAULT_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
          resources: {},
          extensions: {
            [MCP_SKILLS_EXTENSION_ID]: {
              directoryRead: true,
            },
          },
        },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: MCP_SERVER_VERSION,
        },
      });
    }

    case "ping":
      return makeResult(id, {});

    case "tools/list":
      return makeResult(id, { tools: MCP_TOOLS });

    case "tools/call": {
      const toolName = asNonEmptyString(params.name);
      const args = asRecord(params.arguments);
      if (!toolName) {
        return makeError(id, -32602, "Missing tool name");
      }

      if (toolName === "verify_manifest") {
        const manifestDir = asNonEmptyString(args.manifestDir);
        if (!manifestDir) {
          return makeError(id, -32602, "verify_manifest requires string parameter 'manifestDir'");
        }
        if (args.offline !== undefined && typeof args.offline !== "boolean") {
          return makeError(id, -32602, "verify_manifest parameter 'offline' must be boolean");
        }
        if (args.verifySha256 !== undefined && typeof args.verifySha256 !== "boolean") {
          return makeError(id, -32602, "verify_manifest parameter 'verifySha256' must be boolean");
        }
        try {
          const report = await runManifestGate(
            {
              manifestDir,
              binaryPath: asNonEmptyString(args.binaryPath) ?? undefined,
              sandboxResultPath: asNonEmptyString(args.sandboxResultPath) ?? undefined,
              offline: args.offline,
              verifySha256: args.verifySha256,
              minManifestVersion: asNonEmptyString(args.minManifestVersion) ?? undefined,
            },
            deps.gateDeps,
          );
          return makeResult(id, {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            structuredContent: report,
            isError: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return makeResult(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      if (toolName === "verify_binary") {
        const binaryPath = asNonEmptyString(args.binaryPath);
        if (!binaryPath) {
          return makeError(id, -32602, "verify_binary requires string parameter 'binaryPath'");
        }
        let expectedArchitecture: PeArchitecture | undefined;
        if (args.expectedArchitecture !== undefined) {
          const archRaw = asNonEmptyString(args.expectedArchitecture);
          if (archRaw !== "x64" && archRaw !== "x86" && archRaw !== "arm64") {
            return makeError(
              id,
              -32602,
              "verify_binary parameter 'expectedArchitecture' must be one of: x64, x86, arm64",
            );
          }
          expectedArchitecture = archRaw;
        }
        const report = runBinaryGate({ binaryPath, expectedArchitecture }, deps.gateDeps);
        return makeResult(id, {
          content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
          structuredContent: report,
          isError: false,
        });
      }

      if (toolName === "prepare_sandbox") {
        const manifestDir = asNonEmptyString(args.manifestDir);
        const outDir = asNonEmptyString(args.outDir);
        if (!manifestDir || !outDir) {
          return makeError(
            id,
            -32602,
            "prepare_sandbox requires string parameters 'manifestDir' and 'outDir'",
          );
        }
        if (args.skipUninstall !== undefined && typeof args.skipUninstall !== "boolean") {
          return makeError(id, -32602, "prepare_sandbox parameter 'skipUninstall' must be boolean");
        }
        if (args.enableVgpu !== undefined && typeof args.enableVgpu !== "boolean") {
          return makeError(id, -32602, "prepare_sandbox parameter 'enableVgpu' must be boolean");
        }
        let probeCommands: string[] | undefined;
        if (args.probeCommands !== undefined) {
          if (
            !Array.isArray(args.probeCommands) ||
            !args.probeCommands.every((item) => typeof item === "string")
          ) {
            return makeError(
              id,
              -32602,
              "prepare_sandbox parameter 'probeCommands' must be string[]",
            );
          }
          probeCommands = args.probeCommands;
        }
        try {
          const prepared = runSandboxPrepare({
            manifestDir,
            outDir,
            wingetPkgsRoot: asNonEmptyString(args.wingetPkgsRoot) ?? undefined,
            probeCommands,
            skipUninstall: args.skipUninstall,
            enableVgpu: args.enableVgpu,
          });
          return makeResult(id, {
            content: [{ type: "text", text: JSON.stringify(prepared, null, 2) }],
            structuredContent: prepared,
            isError: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return makeResult(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      if (toolName === "evaluate_sandbox") {
        const manifestDir = asNonEmptyString(args.manifestDir);
        const resultPath = asNonEmptyString(args.resultPath);
        if (!manifestDir || !resultPath) {
          return makeError(
            id,
            -32602,
            "evaluate_sandbox requires string parameters 'manifestDir' and 'resultPath'",
          );
        }
        try {
          const report = runSandboxEval({ manifestDir, resultPath }, deps.gateDeps);
          return makeResult(id, {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            structuredContent: report,
            isError: false,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return makeResult(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      return makeError(id, -32602, `Unknown tool: ${toolName}`);
    }

    case "resources/list":
      return makeResult(id, catalog.listResources());

    case "resources/read": {
      const uri = asNonEmptyString(params.uri);
      if (!uri) {
        return makeError(id, -32602, "resources/read requires string parameter 'uri'");
      }
      const content = catalog.readResource(uri);
      if (!content) {
        return makeError(id, -32002, `Resource not found: ${uri}`);
      }
      return makeResult(id, content);
    }

    case "resources/directory/read": {
      const uri = asNonEmptyString(params.uri);
      if (!uri) {
        return makeError(id, -32602, "resources/directory/read requires string parameter 'uri'");
      }
      const dir = catalog.readDirectory(uri);
      if (!dir) {
        return makeError(id, -32602, `Directory not found or not a directory: ${uri}`);
      }
      return makeResult(id, dir);
    }

    case "skills/list":
      return makeResult(id, catalog.listSkills());

    case "skills/get": {
      const uri = asNonEmptyString(params.uri);
      if (!uri) {
        return makeError(id, -32602, "skills/get requires string parameter 'uri'");
      }
      const skill = catalog.getSkill(uri);
      if (!skill) {
        return makeError(id, -32602, `Skill not found: ${uri}`);
      }
      return makeResult(id, { skill });
    }

    default:
      return makeError(id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function runStdioMcpServer(
  deps: McpServerDeps = {},
  io: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const catalog = deps.catalog ?? new SkillCatalog();
  const resolvedDeps: McpServerDeps = { ...deps, catalog };

  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(makeError(null, -32700, "Parse error"))}\n`);
      continue;
    }
    const response = await handleJsonRpcMessage(parsed, resolvedDeps);
    if (response !== null) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  }
}
