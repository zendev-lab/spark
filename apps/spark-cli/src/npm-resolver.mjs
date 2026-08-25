import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDist = resolve(packageDirectory, "dist");
const require = createRequire(import.meta.url);
const targets = new Map([
  ["darwin-arm64", { alias: "@zendev-lab/spark-cli-darwin-arm64", target: "aarch64-apple-darwin" }],
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

function configureCompanions() {
  process.env.SPARK_PRODUCT_DIST ??= productDist;
  process.env.SPARK_BUILD_INFO_PATH ??= resolve(productDist, "build-info.json");
  process.env.SPARK_CLI_COMMAND_PATH ??= process.argv[1];
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
