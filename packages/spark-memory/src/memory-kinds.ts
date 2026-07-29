import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ToolConfig } from "@zendev-lab/spark-core";
import {
  defaultLearningStore,
  parseLearningExportMarkdown,
  renderLearningExportMarkdown,
  type LearningCategory,
  type LearningLocation,
  type LearningRecord,
  type LearningStatus,
} from "./learning-store.ts";
import {
  defaultRecallStore,
  type RecallCandidate,
  type RecallScope,
  type RecallStorePaths,
} from "./recall-store.ts";

export type SparkMemoryKind = "entry" | "learning" | "candidate";

export type SparkMemoryLearningAction =
  | "record"
  | "search"
  | "list"
  | "read"
  | "mark_stale"
  | "supersede"
  | "reject"
  | "export_markdown"
  | "import_markdown";

export type SparkMemoryCandidateAction =
  | "record"
  | "record_candidate"
  | "list"
  | "search"
  | "audit"
  | "gc"
  | "promote"
  | "restore"
  | "reject";

type ToolResult = Awaited<ReturnType<ToolConfig["execute"]>>;

export async function executeMemoryCandidateAction(input: {
  params: Record<string, unknown>;
  cwd: string;
  storePaths?: RecallStorePaths;
}): Promise<ToolResult> {
  const { params, cwd, storePaths } = input;
  const action = normalizeCandidateAction(params.action);
  const scope = normalizeRecallScope(params.scope);
  const store = defaultRecallStore(cwd, scope, storePaths);
  if (action === "record" || action === "record_candidate") {
    const candidate = await store.record({
      scope,
      text: requiredString(params.text, "text"),
      reason: requiredString(params.reason, "reason"),
      evidenceRefs: optionalStringArray(params.evidenceRefs, "evidenceRefs"),
    });
    return result(`Recorded recall candidate ${candidate.id} (${scope}).`, { candidate });
  }
  if (action === "search") {
    const candidates = await store.search(requiredString(params.query, "query"));
    return result(renderCandidates(candidates, "Search recall candidates"), { candidates });
  }
  if (action === "audit" || action === "gc") {
    const candidates = await store.list();
    const olderThanDays = optionalNonNegativeNumber(params.olderThanDays, 7, "olderThanDays");
    const plan = createRecallCandidateGcPlan(candidates, scope, olderThanDays);
    if (action === "audit" || !optionalBoolean(params.apply, false, "apply")) {
      return result(renderRecallCandidateGcPlan(plan), { apply: false, plan });
    }
    const planDigest = requiredString(params.planDigest, "planDigest");
    if (planDigest !== plan.digest) {
      throw new Error(
        `memory candidate GC plan digest mismatch: expected ${plan.digest}, received ${planDigest}`,
      );
    }
    const rejected = await store.rejectMany(
      plan.items.map((item) => item.id),
      `Automatic recall quarantine: ${plan.reasonSummary}`,
    );
    return result(`Rejected ${rejected.length} recall candidate(s) using plan ${plan.digest}.`, {
      apply: true,
      plan,
      rejected,
    });
  }
  if (action === "promote") {
    const candidate = await store.promote(
      requiredString(params.id, "id"),
      requiredString(params.promotedTo ?? params.ref, "promotedTo"),
    );
    return result(`Promoted recall candidate ${candidate.id} to ${candidate.promotedTo}.`, {
      candidate,
    });
  }
  if (action === "restore") {
    const ids =
      params.ids === undefined
        ? [requiredString(params.id, "id")]
        : requiredStringArray(params.ids, "ids");
    const restored = await store.restoreMany(ids);
    return result(`Restored ${restored.length} recall candidate(s).`, { restored });
  }
  if (action === "reject") {
    const candidate = await store.reject(
      requiredString(params.id, "id"),
      requiredString(params.reason, "reason"),
    );
    return result(`Rejected recall candidate ${candidate.id}.`, { candidate });
  }
  const includeRejected = optionalBoolean(params.includeRejected, false, "includeRejected");
  const candidates = (await store.list()).filter(
    (candidate) => includeRejected || candidate.status === "candidate",
  );
  return result(renderCandidates(candidates, `Recall candidates (${scope})`), { candidates });
}

export async function executeMemoryLearningAction(input: {
  params: Record<string, unknown>;
  cwd: string;
}): Promise<ToolResult> {
  return executeBuiltinLearningAction(
    normalizeLearningAction(input.params.action),
    input.params,
    input.cwd,
  );
}

async function executeBuiltinLearningAction(
  action: SparkMemoryLearningAction,
  params: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  const location = optionalLearningLocation(params.location);
  const store = defaultLearningStore(cwd, location);

  if (action === "record") {
    const artifact = await store.record({
      id: optionalString(params.id),
      title: requiredString(params.title, "title"),
      statement: requiredString(params.statement, "statement"),
      category: optionalLearningCategory(params.category),
      status: optionalLearningStatus(params.status),
      applicability: optionalString(params.applicability),
      nonApplicability: optionalString(params.nonApplicability),
      rationale: optionalString(params.rationale),
      evidenceRefs: optionalStringArray(params.evidenceRefs, "evidenceRefs"),
      sourcePaths: optionalStringArray(params.sourcePaths, "sourcePaths"),
      sourceHash: optionalString(params.sourceHash),
      sourceContent: optionalString(params.sourceContent),
      dependsOn: optionalStringArray(params.dependsOn, "dependsOn"),
      supersedes: optionalStringArray(params.supersedes, "supersedes"),
      contradictedBy: optionalStringArray(params.contradictedBy, "contradictedBy"),
      tags: optionalStringArray(params.tags, "tags"),
      confidence: optionalNumber(params.confidence, "confidence"),
    });
    return result(
      `Recorded learning ${artifact.ref} [${artifact.body.status}] ${artifact.body.title}`,
      { learning: artifact },
    );
  }

  if (action === "search") {
    const detailed = await store.searchDetailed({
      query: requiredString(params.query, "query"),
      status: optionalLearningStatusFilter(params.status),
      category: optionalLearningCategory(params.category),
      tag: optionalString(params.tag),
      includeCandidates: optionalBoolean(params.includeCandidates, false, "includeCandidates"),
      includeInactive: optionalBoolean(params.includeInactive, false, "includeInactive"),
      limit: optionalPositiveInt(params.limit, 10, "limit"),
    });
    const lines = [
      `Spark learnings: ${detailed.results.length} result(s)`,
      ...detailed.results.map(
        (entry) =>
          `- ${entry.record.title} (${entry.ref}, score=${entry.score.toFixed(2)}) ${entry.record.statement}`,
      ),
      ...detailed.diagnostics.map((diagnostic) => `- warning: ${diagnostic.message}`),
    ];
    if (detailed.results.length === 0) lines.push("- No matching learnings.");
    return result(lines.join("\n"), {
      count: detailed.results.length,
      results: detailed.results,
      warnings: detailed.diagnostics,
    });
  }

  if (action === "list") {
    const detailed = await store.listDetailed({
      status: optionalLearningStatusFilter(params.status),
      category: optionalLearningCategory(params.category),
      tag: optionalString(params.tag),
      includeCandidates: optionalBoolean(params.includeCandidates, false, "includeCandidates"),
      includeInactive: optionalBoolean(params.includeInactive, false, "includeInactive"),
    });
    const limit = optionalPositiveInt(params.limit, 20, "limit");
    const visible = detailed.artifacts.slice(0, limit);
    const lines = [
      `Spark learnings: ${detailed.artifacts.length}${
        visible.length < detailed.artifacts.length ? ` (showing ${visible.length})` : ""
      }`,
      ...visible.map(
        (artifact) =>
          `- [${artifact.body.status}/${artifact.body.category}/${store.location}] ${artifact.ref} ${artifact.body.title}`,
      ),
      ...detailed.diagnostics.map((diagnostic) => `- warning: ${diagnostic.message}`),
    ];
    if (visible.length === 0) lines.push("- No learnings.");
    return result(lines.join("\n"), {
      count: detailed.artifacts.length,
      shown: visible.length,
      learnings: visible,
      warnings: detailed.diagnostics,
    });
  }

  if (action === "read") {
    const artifact = await store.get(requiredString(params.ref ?? params.id, "ref"));
    const maxChars = optionalPositiveInt(params.maxChars, 4_000, "maxChars");
    const body = JSON.stringify(artifact.body, null, 2);
    const rendered = body.length > maxChars ? `${body.slice(0, Math.max(0, maxChars - 1))}…` : body;
    return result(
      [
        `${artifact.ref} [${artifact.body.status}/${artifact.body.category}/${store.location}] ${artifact.body.title}`,
        `updated=${artifact.updatedAt} evidence=${artifact.body.evidenceRefs.length}`,
        "",
        rendered,
      ].join("\n"),
      { learning: artifact, bodyChars: body.length, shownChars: rendered.length },
    );
  }

  if (action === "mark_stale") {
    const artifact = await store.markStale(
      requiredString(params.ref ?? params.id, "ref"),
      requiredString(params.reason, "reason"),
    );
    return result(`Marked stale ${artifact.ref}: ${artifact.body.title}`, { learning: artifact });
  }

  if (action === "supersede") {
    const artifact = await store.markSuperseded(
      requiredString(params.ref ?? params.id, "ref"),
      requiredStringArray(params.supersededBy, "supersededBy"),
      optionalString(params.reason),
    );
    return result(`Marked superseded ${artifact.ref}: ${artifact.body.title}`, {
      learning: artifact,
    });
  }

  if (action === "reject") {
    const artifact = await store.rejectCandidate(
      requiredString(params.ref ?? params.id, "ref"),
      requiredString(params.reason, "reason"),
    );
    return result(`Rejected learning ${artifact.ref}: ${artifact.body.title}`, {
      learning: artifact,
    });
  }

  if (action === "export_markdown") {
    const artifacts = await store.list({
      status: optionalLearningStatusFilter(params.status),
      includeCandidates: optionalBoolean(params.includeCandidates, false, "includeCandidates"),
      includeInactive: optionalBoolean(params.includeInactive, false, "includeInactive"),
    });
    const markdown = renderLearningExportMarkdown(artifacts.map((artifact) => artifact.body));
    const outputPathValue = optionalString(params.outputPath);
    const outputPath = outputPathValue ? resolve(cwd, outputPathValue) : undefined;
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, markdown, "utf8");
    }
    return result(
      `Exported ${artifacts.length} learning(s)${outputPath ? ` to ${outputPath}` : ""}`,
      { count: artifacts.length, outputPath, markdown },
    );
  }

  // import_markdown
  const inputPath = resolve(cwd, requiredString(params.inputPath, "inputPath"));
  const apply = optionalBoolean(params.apply, false, "apply");
  const markdown = await readFile(inputPath, "utf8");
  const records = parseLearningExportMarkdown(markdown, inputPath);
  if (records.length === 0) {
    throw new Error(
      `[E_LEARNING_IMPORT_FORMAT] No learning export blocks found in ${inputPath}. Use export_markdown then import_markdown with dry-run before apply=true.`,
    );
  }
  const imported: LearningRecord[] = [];
  if (apply) {
    for (const record of records) {
      imported.push((await store.restore(record)).body);
    }
  }
  return result(
    `${apply ? "Imported" : "Dry-run parsed"} ${records.length} learning(s) from ${inputPath}`,
    { apply, count: records.length, imported, records },
  );
}

export function normalizeMemoryKind(value: unknown): SparkMemoryKind {
  if (value === undefined || value === null || value === "") return "entry";
  if (value === "entry" || value === "learning" || value === "candidate") return value;
  throw new Error('memory.kind must be "entry", "learning", or "candidate"');
}

function normalizeCandidateAction(value: unknown): SparkMemoryCandidateAction {
  if (
    value === "record" ||
    value === "record_candidate" ||
    value === "list" ||
    value === "search" ||
    value === "audit" ||
    value === "gc" ||
    value === "promote" ||
    value === "restore" ||
    value === "reject"
  ) {
    return value;
  }
  throw new Error(
    "memory.action for kind=candidate must be record, record_candidate, list, search, audit, gc, promote, restore, or reject",
  );
}

function normalizeLearningAction(value: unknown): SparkMemoryLearningAction {
  const actions: readonly SparkMemoryLearningAction[] = [
    "record",
    "search",
    "list",
    "read",
    "mark_stale",
    "supersede",
    "reject",
    "export_markdown",
    "import_markdown",
  ];
  if (actions.includes(value as SparkMemoryLearningAction)) {
    return value as SparkMemoryLearningAction;
  }
  throw new Error(`memory.action for kind=learning must be one of: ${actions.join(", ")}`);
}

function normalizeRecallScope(value: unknown): RecallScope {
  if (value === "user" || value === "workspace" || value === "repo") return value;
  throw new Error("memory.scope must be user, workspace, or repo");
}

interface RecallCandidateGcPlanItem {
  id: string;
  kind: RecallCandidate["kind"];
  updatedAt: string;
  reasonCode: "compaction_open_item" | "compaction_snapshot";
}

interface RecallCandidateGcPlan {
  schemaVersion: 1;
  scope: RecallScope;
  olderThanDays: number;
  generatedAt: string;
  reasonSummary: string;
  digest: string;
  items: RecallCandidateGcPlanItem[];
}

function createRecallCandidateGcPlan(
  candidates: readonly RecallCandidate[],
  scope: RecallScope,
  olderThanDays: number,
): RecallCandidateGcPlan {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1_000;
  const items = candidates
    .filter(
      (candidate) =>
        candidate.scope === scope &&
        candidate.status === "candidate" &&
        Boolean(candidate.sourceSessionId) &&
        Date.parse(candidate.updatedAt) <= cutoff,
    )
    .map(
      (candidate): RecallCandidateGcPlanItem => ({
        id: candidate.id,
        kind: candidate.kind,
        updatedAt: candidate.updatedAt,
        reasonCode: candidate.kind === "open_item" ? "compaction_open_item" : "compaction_snapshot",
      }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const reasonSummary =
    "session-scoped compaction candidates exceeded their recall TTL; explicit candidates remain protected";
  const digest = createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, scope, olderThanDays, items }))
    .digest("hex");
  return {
    schemaVersion: 1,
    scope,
    olderThanDays,
    generatedAt: new Date().toISOString(),
    reasonSummary,
    digest,
    items,
  };
}

function renderRecallCandidateGcPlan(plan: RecallCandidateGcPlan): string {
  const byReason = new Map<string, number>();
  for (const item of plan.items)
    byReason.set(item.reasonCode, (byReason.get(item.reasonCode) ?? 0) + 1);
  const visible = plan.items.slice(0, 20);
  return [
    `Recall candidate GC plan (${plan.scope})`,
    `- digest: ${plan.digest}`,
    `- eligible: ${plan.items.length}`,
    `- policy: ${plan.reasonSummary}`,
    ...[...byReason.entries()].map(([reason, count]) => `- ${reason}: ${count}`),
    ...visible.map((item) => `  - ${item.id} [${item.reasonCode}]`),
    ...(visible.length < plan.items.length
      ? [`  - … ${plan.items.length - visible.length} more`]
      : []),
  ].join("\n");
}

function renderCandidates(candidates: RecallCandidate[], title: string): string {
  if (candidates.length === 0) return `${title}: none`;
  return [
    title,
    ...candidates.map((candidate) => `- [${candidate.status}] ${candidate.id}: ${candidate.text}`),
  ].join("\n");
}

function result(text: string, details: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text" as const, text }], details };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`memory.${field} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("memory string field must be a string");
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredStringArray(value, field);
}

function requiredStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`memory.${field} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`memory.${field}[${index}] must be a string`);
    return entry;
  });
}

function optionalBoolean(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`memory.${field} must be a boolean`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`memory.${field} must be a finite number`);
  }
  return value;
}

function optionalPositiveInt(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`memory.${field} must be a positive number`);
  }
  return Math.floor(value);
}

function optionalNonNegativeNumber(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`memory.${field} must be a non-negative number`);
  }
  return value;
}

function optionalLearningLocation(value: unknown): LearningLocation | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "user" || value === "workspace" || value === "repo") return value;
  throw new Error("memory.location must be user, workspace, or repo");
}

function optionalLearningCategory(value: unknown): LearningCategory | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const allowed: LearningCategory[] = [
    "pattern",
    "gotcha",
    "decision",
    "workflow",
    "tool",
    "project",
  ];
  if (allowed.includes(value as LearningCategory)) return value as LearningCategory;
  throw new Error(`memory.category must be one of: ${allowed.join(", ")}`);
}

function optionalLearningStatus(value: unknown): LearningStatus | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("memory.status must be a string");
  const allowed: LearningStatus[] = ["candidate", "active", "stale", "superseded", "rejected"];
  if (allowed.includes(value as LearningStatus)) return value as LearningStatus;
  throw new Error(`memory.status must be one of: ${allowed.join(", ")}`);
}

function optionalLearningStatusFilter(
  value: unknown,
): LearningStatus | LearningStatus[] | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const status = optionalLearningStatus(entry);
      if (!status) throw new Error(`memory.status[${index}] is required`);
      return status;
    });
  }
  return optionalLearningStatus(value);
}
