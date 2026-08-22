import { formatSparkCliError, SparkCliError } from "@zendev-lab/spark-i18n/cli";
import { resolveSparkPaths, resolveSparkUserPaths } from "@zendev-lab/spark-system";

export function runSparkPathsCommand(argv: string[] = process.argv.slice(2)): number {
  const unknown = argv.filter((argument) => argument !== "--json");
  if (unknown.length > 0) {
    process.stderr.write(
      formatSparkCliError(
        new SparkCliError({
          code: "INVALID_ARGUMENT",
          title: "spark paths accepts only the optional --json flag",
          hints: ['Run "spark paths --json" for machine-readable output.'],
          exitCode: 2,
        }),
      ),
    );
    return 2;
  }
  const payload = pathPayload();
  process.stdout.write(
    argv.includes("--json") ? `${JSON.stringify(payload, null, 2)}\n` : formatPaths(payload),
  );
  return 0;
}

function publicPaths(paths: ReturnType<typeof resolveSparkPaths>) {
  const { sessionRuntimeDir: _sessionRuntimeDir, ...publicValues } = paths;
  return publicValues;
}

function formatPaths(payload: ReturnType<typeof pathPayload>): string {
  const lines = [`SPARK_HOME=${payload.sparkHome ?? "<unset>"}`, "", "user:"];
  for (const [key, value] of Object.entries(payload.user)) lines.push(`  ${key}=${value}`);
  for (const [label, paths] of [
    ["hub", payload.hub],
    ["daemon", payload.daemon],
  ] as const) {
    lines.push("", `${label}:`);
    for (const [key, value] of Object.entries(paths)) lines.push(`  ${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

function pathPayload() {
  return {
    sparkHome: process.env.SPARK_HOME?.trim() ?? null,
    user: resolveSparkUserPaths(),
    hub: publicPaths(resolveSparkPaths({ app: "hub" })),
    daemon: publicPaths(resolveSparkPaths({ app: "daemon" })),
  };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  process.exitCode = runSparkPathsCommand();
}
