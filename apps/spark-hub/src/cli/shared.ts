/** Shared output helpers for Spark Hub command surfaces. */

export interface SparkCliOutput {
  write(text: string): void;
}

export const consoleSparkCliOutput: SparkCliOutput = {
  write(text) {
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },
};

export const consoleSparkCliErrorOutput: SparkCliOutput = {
  write(text) {
    process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
  },
};

export function printSparkCliResult(
  output: SparkCliOutput,
  value: unknown,
  options: { json?: boolean } = {},
): void {
  if (options.json) {
    output.write(JSON.stringify(value, null, 2));
    return;
  }
  output.write(formatSparkCliHuman(value));
}

export function formatSparkCliHuman(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "symbol") return value.description ?? "";
  if (typeof value === "function") return value.name ? `[function ${value.name}]` : "[function]";
  if (Array.isArray(value)) return value.map(formatSparkCliHuman).join("\n");
  const lines: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (typeof entry === "object" && entry !== null) {
      lines.push(`${key}: ${JSON.stringify(entry)}`);
    } else {
      lines.push(`${key}: ${formatSparkCliHuman(entry)}`);
    }
  }
  return lines.join("\n");
}
