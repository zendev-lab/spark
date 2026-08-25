import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDist = resolve(packageDirectory, "dist");
const require = createRequire(import.meta.url);
const targets = new Map([
  ["darwin-arm64", { alias: "@zendev-lab/spark-cli-darwin-arm64", target: "aarch64-apple-darwin" }],
  ["darwin-x64", { alias: "@zendev-lab/spark-cli-darwin-x64", target: "x86_64-apple-darwin" }],
  [
    "linux-arm64",
    { alias: "@zendev-lab/spark-cli-linux-arm64", target: "aarch64-unknown-linux-musl" },
  ],
  ["linux-x64", { alias: "@zendev-lab/spark-cli-linux-x64", target: "x86_64-unknown-linux-musl" }],
]);

export function resolveNativeSparkBinary(platform = process.platform, arch = process.arch) {
  const selected = targets.get(`${platform}-${arch}`);
  if (!selected) return { error: "UNSUPPORTED_PLATFORM", detail: `${platform}/${arch}` };
  let manifest;
  try {
    manifest = require.resolve(`${selected.alias}/package.json`);
  } catch (error) {
    return {
      error: "NATIVE_PACKAGE_MISSING",
      detail: `${selected.alias}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const binary = resolve(dirname(manifest), "vendor", selected.target, "spark");
  if (!existsSync(binary)) return { error: "NATIVE_PACKAGE_MISSING", detail: binary };
  return { binary, target: selected.target, alias: selected.alias };
}

export function runNativeSpark(argv = process.argv.slice(2)) {
  const resolved = resolveNativeSparkBinary();
  if (!resolved.binary) return printDiagnostic(resolved.error, resolved.detail);
  configureCompanions();
  if (typeof process.execve !== "function") {
    return printDiagnostic(
      "DISPATCH_FAILED",
      "This Spark release requires Node.js 24 or newer with process.execve support.",
    );
  }
  try {
    process.execve(resolved.binary, [resolved.binary, ...argv], process.env);
  } catch (error) {
    return printDiagnostic(
      "DISPATCH_FAILED",
      error instanceof Error ? error.message : String(error),
    );
  }
  return 1;
}

export function resolveStableSparkCommand(env = process.env, platform = process.platform) {
  const names = platform === "win32" ? ["spark.cmd", "spark.exe", "spark"] : ["spark"];
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep looking for the install owner's executable shim.
      }
    }
  }
  return undefined;
}

export function configureStableLauncher(
  env = process.env,
  cliCommandPath = process.argv[1],
  platform = process.platform,
) {
  // `process.argv[1]` is the versioned npm-resolver path after an npm/pnpm shim
  // enters Node. Resolve the public `spark` command from PATH first so restart
  // successors re-enter through the install owner after a package update.
  env.SPARK_CLI_COMMAND_PATH ??= resolveStableSparkCommand(env, platform) ?? cliCommandPath;
  env.SPARK_STABLE_LAUNCHER ??= env.SPARK_CLI_COMMAND_PATH;
}

function configureCompanions() {
  process.env.SPARK_PRODUCT_DIST ??= productDist;
  process.env.SPARK_BUILD_INFO_PATH ??= resolve(productDist, "build-info.json");
  configureStableLauncher();
  process.env.SPARK_DEPLOYMENT_ROOT ??= packageDirectory;
  process.env.SPARK_DAEMON_COMMAND ??= executable("@zendev-lab/spark-daemon/executable");
  process.env.SPARK_HUB_COMMAND ??= executable("@zendev-lab/spark-hub/executable");
  process.env.SPARK_ACP_COMMAND ??= resolve(packageDirectory, "bin", "spark-acp");
  process.env.SPARK_MCP_COMMAND ??= resolve(packageDirectory, "bin", "spark-mcp");
  process.env.SPARK_PATHS_COMMAND ??= resolve(packageDirectory, "bin", "spark-paths");
  process.env.SPARK_WEB_COMMAND ??= executable("@zendev-lab/spark-web/executable");
  process.env.SPARK_WEB_DSH_COMMAND ??= executable("@zendev-lab/spark-web-dsh/executable");
}

function executable(specifier) {
  return fileURLToPath(import.meta.resolve(specifier));
}

function printDiagnostic(code, detail) {
  const catalog = JSON.parse(readFileSync(resolve(productDist, "cli-diagnostics.json"), "utf8"));
  const descriptor = catalog.diagnostics?.[code] ?? {
    code,
    title: "Spark command failed",
    hints: [],
    exitCode: 1,
  };
  const color = process.stderr.isTTY && !process.env.NO_COLOR;
  const prefix = color ? "\u001b[1;31merror\u001b[0m" : "error";
  process.stderr.write(`${prefix} [${descriptor.code}]: ${descriptor.title}\n`);
  if (descriptor.description) process.stderr.write(`  ${descriptor.description}\n`);
  for (const hint of descriptor.hints ?? []) process.stderr.write(`hint: ${hint}\n`);
  if (detail) process.stderr.write(`details: ${detail}\n`);
  return descriptor.exitCode ?? 1;
}
