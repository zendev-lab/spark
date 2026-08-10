#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SparkExtensionLoader, SparkHostRuntime } from "../apps/spark-tui/src/host/index.ts";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselinePath = resolve(repositoryRoot, "architecture/tool-surface-baseline.json");
const DEFAULT_PROFILE = "spark-native-default";

const ALIAS_PAIRS = [
  ["project", "projectRef"],
  ["task", "taskRef"],
  ["role", "roleRef"],
  ["artifact", "artifactRef"],
] as const;

export interface ToolSurfaceMetrics {
  modelFacingBytes: number;
  schemaBytes: number;
  propertyCount: number;
  optionalFieldCount: number;
  untypedFieldCount: number;
  aliasPairCount: number;
  actionCount: number;
  unionBranchCount: number;
}

interface ToolSurfaceMeasurement extends ToolSurfaceMetrics {
  name: string;
  effect: string;
}

interface ToolSurfaceBudget extends ToolSurfaceMetrics {
  effect: string;
}

interface ToolSurfaceBaseline {
  format: "spark.tool-surface-baseline/v1";
  profile: typeof DEFAULT_PROFILE;
  maxActiveTools: number;
  tools: Record<string, ToolSurfaceBudget>;
}

interface ToolSurfaceConfig {
  name: string;
  label?: string;
  description?: string;
  promptGuidelines?: readonly string[];
  parameters?: unknown;
}

export function measureToolSurface(
  config: ToolSurfaceConfig,
  effect = "unknown",
): ToolSurfaceMeasurement {
  const schema = asRecord(config.parameters) ?? {};
  const schemaText = stableJson(schema);
  const promptText = [
    config.name,
    config.label ?? "",
    config.description ?? "",
    ...(config.promptGuidelines ?? []),
    schemaText,
  ].join("\n");
  const counters = {
    propertyCount: 0,
    optionalFieldCount: 0,
    untypedFieldCount: 0,
    aliasPairCount: 0,
    unionBranchCount: 0,
  };
  visitSchema(schema, counters);
  return {
    name: config.name,
    effect,
    modelFacingBytes: Buffer.byteLength(promptText),
    schemaBytes: Buffer.byteLength(schemaText),
    propertyCount: counters.propertyCount,
    optionalFieldCount: counters.optionalFieldCount,
    untypedFieldCount: counters.untypedFieldCount,
    aliasPairCount: counters.aliasPairCount,
    actionCount: collectActionValues(schema).size,
    unionBranchCount: counters.unionBranchCount,
  };
}

export function toolSurfaceBaselineViolations(
  baseline: ToolSurfaceBaseline,
  measurements: readonly ToolSurfaceMeasurement[],
): string[] {
  const violations: string[] = [];
  if (measurements.length > baseline.maxActiveTools) {
    violations.push(
      `default active tool count grew: ${measurements.length} > ${baseline.maxActiveTools}`,
    );
  }
  for (const measurement of measurements) {
    const budget = baseline.tools[measurement.name];
    if (!budget) {
      violations.push(`new default model-facing tool is not budgeted: ${measurement.name}`);
      continue;
    }
    if (measurement.effect !== budget.effect) {
      violations.push(
        `${measurement.name} effect changed: ${measurement.effect} != ${budget.effect}`,
      );
    }
    for (const key of METRIC_KEYS) {
      if (measurement[key] > budget[key]) {
        violations.push(`${measurement.name} ${key} grew: ${measurement[key]} > ${budget[key]}`);
      }
    }
  }
  return violations;
}

const METRIC_KEYS = [
  "modelFacingBytes",
  "schemaBytes",
  "propertyCount",
  "optionalFieldCount",
  "untypedFieldCount",
  "aliasPairCount",
  "actionCount",
  "unionBranchCount",
] as const satisfies readonly (keyof ToolSurfaceMetrics)[];

async function main(): Promise<void> {
  const baseline = parseBaseline(JSON.parse(await readFile(baselinePath, "utf8")) as unknown);
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-tool-surface-check" });
  const loaded = await new SparkExtensionLoader({ api: host }).load();
  const failedExtensions = loaded.outcomes.filter((outcome) => !outcome.ok);
  if (failedExtensions.length > 0) {
    throw new Error(
      `default extension profile failed to load: ${failedExtensions
        .map((outcome) => `${outcome.specifier}: ${outcome.error ?? "unknown error"}`)
        .join("; ")}`,
    );
  }
  const measurements = host
    .listTools()
    .filter((tool) => tool.active)
    .map((tool) =>
      measureToolSurface(tool.config as ToolSurfaceConfig, tool.policy.effect ?? "unknown"),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const violations = toolSurfaceBaselineViolations(baseline, measurements);
  if (violations.length > 0) {
    console.error(
      ["Tool-surface ratchet failed:", ...violations.map((entry) => `- ${entry}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }
  const totalBytes = measurements.reduce(
    (total, measurement) => total + measurement.modelFacingBytes,
    0,
  );
  const largest = [...measurements]
    .sort((left, right) => right.modelFacingBytes - left.modelFacingBytes)
    .slice(0, 5)
    .map((measurement) => `${measurement.name}=${measurement.modelFacingBytes}`)
    .join(", ");
  console.log(
    `Tool-surface ratchet passed (${measurements.length}/${baseline.maxActiveTools} active tools; ${totalBytes} model-facing bytes; largest: ${largest}).`,
  );
}

function visitSchema(
  value: unknown,
  counters: {
    propertyCount: number;
    optionalFieldCount: number;
    untypedFieldCount: number;
    aliasPairCount: number;
    unionBranchCount: number;
  },
): void {
  if (Array.isArray(value)) {
    for (const entry of value) visitSchema(entry, counters);
    return;
  }
  const schema = asRecord(value);
  if (!schema) return;
  const properties = asRecord(schema.properties);
  if (properties) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
    const names = Object.keys(properties);
    counters.propertyCount += names.length;
    counters.optionalFieldCount += names.filter((name) => !required.has(name)).length;
    counters.aliasPairCount += ALIAS_PAIRS.filter(
      ([left, right]) => left in properties && right in properties,
    ).length;
    for (const property of Object.values(properties)) {
      if (isUntypedField(property)) counters.untypedFieldCount += 1;
    }
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) counters.unionBranchCount += schema[key].length;
  }
  for (const child of Object.values(schema)) visitSchema(child, counters);
}

function collectActionValues(schema: Record<string, unknown>): Set<string> {
  const values = new Set<string>();
  for (const branch of schemaBranches(schema)) {
    const action = asRecord(asRecord(branch.properties)?.action);
    if (!action) continue;
    addLiteralValues(action, values);
    if (values.size === 0 && typeof action.description === "string") {
      for (const candidate of action.description.split("|")) {
        const normalized = candidate.trim().replace(/[.;].*$/u, "");
        if (/^[a-z][a-z0-9_]*$/u.test(normalized)) values.add(normalized);
      }
    }
  }
  return values;
}

function schemaBranches(schema: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      return branches.map(asRecord).filter((entry): entry is Record<string, unknown> => !!entry);
    }
  }
  return [schema];
}

function addLiteralValues(schema: Record<string, unknown>, values: Set<string>): void {
  if (typeof schema.const === "string") values.add(schema.const);
  if (Array.isArray(schema.enum)) {
    for (const entry of schema.enum) if (typeof entry === "string") values.add(entry);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    for (const branch of schema[key]) {
      const record = asRecord(branch);
      if (record) addLiteralValues(record, values);
    }
  }
}

function isUntypedField(value: unknown): boolean {
  const schema = asRecord(value);
  if (!schema) return false;
  return !["type", "const", "enum", "$ref", "anyOf", "oneOf", "allOf"].some((key) => key in schema);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (record) {
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseBaseline(value: unknown): ToolSurfaceBaseline {
  const record = asRecord(value);
  if (
    record?.format !== "spark.tool-surface-baseline/v1" ||
    record.profile !== DEFAULT_PROFILE ||
    !Number.isInteger(record.maxActiveTools) ||
    !asRecord(record.tools)
  ) {
    throw new Error(`invalid tool-surface baseline: ${baselinePath}`);
  }
  return record as unknown as ToolSurfaceBaseline;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
