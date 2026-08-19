#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { SparkExtensionLoader, SparkHostRuntime } from "@zendev-lab/spark-extension/host";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contractPath = resolve(repositoryRoot, "architecture/tool-surface-contract.json");
const packageInventoryPath = resolve(repositoryRoot, "architecture/packages.json");
const DEFAULT_PROFILE = "spark-native-default";

const TOOL_SURFACE_KINDS = ["action", "capability", "compatibility"] as const;
const CONTRACT_EFFECTS = [
  "read",
  "network_read",
  "control",
  "local_write",
  "external_write",
  "destructive",
  "unclassified",
] as const;

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

export interface ToolSurfaceMeasurement extends ToolSurfaceMetrics {
  name: string;
  effect: string;
}

type ToolSurfaceKind = (typeof TOOL_SURFACE_KINDS)[number];
type ContractEffect = (typeof CONTRACT_EFFECTS)[number];

interface ToolSurfaceContractEntry {
  owner: string;
  kind: ToolSurfaceKind;
  effect: ContractEffect;
}

export interface ToolSurfaceContract {
  format: "spark.tool-surface-contract/v1";
  profile: typeof DEFAULT_PROFILE;
  tools: Record<string, ToolSurfaceContractEntry>;
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

export function toolSurfaceContractViolations(
  contract: ToolSurfaceContract,
  measurements: readonly ToolSurfaceMeasurement[],
): string[] {
  const violations: string[] = [];
  const activeNames = new Set<string>();
  for (const measurement of measurements) {
    if (activeNames.has(measurement.name)) {
      violations.push(`default profile registers duplicate active tool: ${measurement.name}`);
      continue;
    }
    activeNames.add(measurement.name);
    const declaration = contract.tools[measurement.name];
    if (!declaration) {
      violations.push(`active tool lacks architecture classification: ${measurement.name}`);
      continue;
    }
    const declaredRuntimeEffect =
      declaration.effect === "unclassified" ? "unknown" : declaration.effect;
    if (measurement.effect !== declaredRuntimeEffect) {
      violations.push(
        `${measurement.name} effect contract changed: ${measurement.effect} != ${declaration.effect}`,
      );
    }
    if (declaration.kind === "action" && measurement.actionCount === 0) {
      violations.push(
        `${measurement.name} is classified as an action surface but exposes no action discriminant`,
      );
    }
  }
  for (const name of Object.keys(contract.tools).sort()) {
    if (!activeNames.has(name)) {
      violations.push(`classified default tool is not active: ${name}`);
    }
  }
  return violations;
}

async function main(): Promise<void> {
  const packageNames = parsePackageNames(
    JSON.parse(await readFile(packageInventoryPath, "utf8")) as unknown,
  );
  const contract = parseContract(
    JSON.parse(await readFile(contractPath, "utf8")) as unknown,
    packageNames,
  );
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
  const violations = toolSurfaceContractViolations(contract, measurements);
  if (violations.length > 0) {
    console.error(
      ["Tool-surface contract failed:", ...violations.map((entry) => `- ${entry}`)].join("\n"),
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
  const diagnostics = measurements.reduce(
    (totals, measurement) => ({
      properties: totals.properties + measurement.propertyCount,
      optional: totals.optional + measurement.optionalFieldCount,
      untyped: totals.untyped + measurement.untypedFieldCount,
      aliases: totals.aliases + measurement.aliasPairCount,
      actions: totals.actions + measurement.actionCount,
      unionBranches: totals.unionBranches + measurement.unionBranchCount,
    }),
    { properties: 0, optional: 0, untyped: 0, aliases: 0, actions: 0, unionBranches: 0 },
  );
  const unclassified = measurements
    .filter((measurement) => measurement.effect === "unknown")
    .map((measurement) => measurement.name)
    .join(", ");
  console.log(
    `Tool-surface contract passed (${measurements.length} classified active tools; ${totalBytes} model-facing bytes; properties=${diagnostics.properties}, optional=${diagnostics.optional}, untyped=${diagnostics.untyped}, aliases=${diagnostics.aliases}, actions=${diagnostics.actions}, unionBranches=${diagnostics.unionBranches}; largest: ${largest}; unclassified effects (fail-closed): ${unclassified || "none"}).`,
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

function parseContract(value: unknown, packageNames: ReadonlySet<string>): ToolSurfaceContract {
  const record = asRecord(value);
  if (
    record?.format !== "spark.tool-surface-contract/v1" ||
    record.profile !== DEFAULT_PROFILE ||
    !asRecord(record.tools)
  ) {
    throw new Error(`invalid tool-surface contract: ${contractPath}`);
  }
  for (const [name, rawEntry] of Object.entries(record.tools as Record<string, unknown>)) {
    const entry = asRecord(rawEntry);
    if (
      !entry ||
      typeof entry.owner !== "string" ||
      !packageNames.has(entry.owner) ||
      !TOOL_SURFACE_KINDS.includes(entry.kind as ToolSurfaceKind) ||
      !CONTRACT_EFFECTS.includes(entry.effect as ContractEffect)
    ) {
      throw new Error(`invalid tool-surface contract entry: ${contractPath}#tools.${name}`);
    }
  }
  return record as unknown as ToolSurfaceContract;
}

function parsePackageNames(value: unknown): ReadonlySet<string> {
  const packages = asRecord(asRecord(value)?.packages);
  if (!packages) throw new Error(`invalid package inventory: ${packageInventoryPath}`);
  return new Set(Object.keys(packages));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
