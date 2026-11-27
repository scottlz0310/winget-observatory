import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CompileTarget =
  | "bun-windows-x64"
  | "bun-windows-arm64"
  | "bun-linux-x64"
  | "bun-linux-arm64"
  | "bun-darwin-x64"
  | "bun-darwin-arm64";

const SUPPORTED_TARGETS = new Set<string>([
  "bun-windows-x64",
  "bun-windows-arm64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
]);

function readRequiredUtf8(filePath: string, label: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`ビルドに必要な正本ファイルが見つかりません (${label}): ${filePath}`);
  }
  return readFileSync(filePath, "utf8");
}

function resolveVersion(repoRoot: string, explicitVersion?: string): string {
  if (explicitVersion && explicitVersion.trim().length > 0) {
    return explicitVersion.trim().replace(/^v/, "");
  }
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readRequiredUtf8(pkgPath, "root package.json")) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version.trim()) {
    throw new Error(`ルート package.json に有効な version がありません: ${pkgPath}`);
  }
  return pkg.version.trim();
}

function createEmbeddedAssetsPlugin(assets: {
  version: string;
  skillMd: string;
  submissionGuide: string;
  prTemplate: string;
  embeddedAssetsPath: string;
}): Bun.BunPlugin {
  const normalizedTarget = resolve(assets.embeddedAssetsPath).replaceAll("\\", "/");
  return {
    name: "verify-gate-embedded-assets",
    setup(build) {
      build.onLoad({ filter: /embedded-assets\.ts$/ }, (args) => {
        if (resolve(args.path).replaceAll("\\", "/") !== normalizedTarget) {
          return undefined;
        }
        const contents = `
export const EMBEDDED_SKILL_ASSETS = ${JSON.stringify(
          {
            version: assets.version,
            skillMd: assets.skillMd,
            submissionGuide: assets.submissionGuide,
            prTemplate: assets.prTemplate,
          },
          null,
          2,
        )};

export function resolveVerifyGateVersion(_moduleDir, embedded = EMBEDDED_SKILL_ASSETS) {
  return embedded?.version ?? ${JSON.stringify(assets.version)};
}
`;
        return { contents, loader: "ts" };
      });
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let compile = false;
  let target: CompileTarget | undefined;
  let outfile: string | undefined;
  let explicitVersion: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--compile") {
      compile = true;
    } else if (arg === "--target") {
      const val = argv[++i];
      if (!val || !SUPPORTED_TARGETS.has(val)) {
        throw new Error(`未対応の --target です: ${val ?? "(未指定)"}`);
      }
      target = val as CompileTarget;
    } else if (arg === "--outfile") {
      const val = argv[++i];
      if (!val) throw new Error("--outfile には出力パスが必要です");
      outfile = resolve(val);
    } else if (arg === "--version") {
      const val = argv[++i];
      if (!val) throw new Error("--version にはバージョン文字列が必要です");
      explicitVersion = val;
    } else {
      throw new Error(`未知の引数です: ${arg}`);
    }
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(scriptDir, "..");
  const repoRoot = resolve(packageRoot, "..", "..");
  const entrypoint = join(packageRoot, "src", "bin.ts");
  const embeddedAssetsPath = join(packageRoot, "src", "embedded-assets.ts");

  const version = resolveVersion(repoRoot, explicitVersion);
  const skillMd = readRequiredUtf8(
    join(packageRoot, "skills", "winget-verify-gate", "SKILL.md"),
    "SKILL.md",
  );
  const submissionGuide = readRequiredUtf8(
    join(repoRoot, "docs", "winget-pkgs-submission-guide.md"),
    "submission-guide.md",
  );
  const prTemplate = readRequiredUtf8(
    join(repoRoot, "docs", "templates", "winget-pkgs-pr-template.md"),
    "pr-template.md",
  );

  const plugin = createEmbeddedAssetsPlugin({
    version,
    skillMd,
    submissionGuide,
    prTemplate,
    embeddedAssetsPath,
  });

  if (compile) {
    if (!outfile) {
      throw new Error("--compile 時は --outfile <path> を指定してください");
    }
    mkdirSync(dirname(outfile), { recursive: true });
    const result = await Bun.build({
      entrypoints: [entrypoint],
      compile: target ? { target, outfile } : { outfile },
      plugins: [plugin],
    });
    if (!result.success) {
      const logs = result.logs.map((l) => l.message).join("\n");
      throw new Error(`バイナリビルドに失敗しました:\n${logs}`);
    }
    console.log(
      `[verify-gate:build] compiled binary=${outfile} target=${target ?? "host"} version=${version}`,
    );
    return;
  }

  const distDir = join(packageRoot, "dist");
  mkdirSync(distDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: distDir,
    naming: "cli.mjs",
    target: "node",
    format: "esm",
    banner: "#!/usr/bin/env node",
    plugins: [plugin],
  });
  if (!result.success) {
    const logs = result.logs.map((l) => l.message).join("\n");
    throw new Error(`npm バンドルビルドに失敗しました:\n${logs}`);
  }

  const rootLicense = join(repoRoot, "LICENSE");
  if (!existsSync(rootLicense)) {
    throw new Error(`ルート LICENSE が見つかりません: ${rootLicense}`);
  }
  copyFileSync(rootLicense, join(packageRoot, "LICENSE"));

  console.log(
    `[verify-gate:build] built dist/cli.mjs version=${version} embedded=(SKILL.md:${Buffer.byteLength(skillMd)}B, guide:${Buffer.byteLength(submissionGuide)}B, template:${Buffer.byteLength(prTemplate)}B)`,
  );
}

await main();
