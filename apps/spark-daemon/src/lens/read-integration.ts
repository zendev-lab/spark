import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, relative, resolve } from "node:path";

import { readRegularFileSnapshot, type FileContentVersion } from "@zendev-lab/spark-files";
import {
  captureWorkspaceRevision,
  OXFMT_PROVIDER_ID,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  VITE_PLUS_CONTRIBUTOR_ID,
  type LensReadAnalysisMode,
  type LensReadAnnotation,
  type LensFixKind,
  type LensReadRepairMode,
  type LensReadRepairReceipt,
  type LensWorkspaceChange,
  type Observation,
  type PatchProposal,
  type ProviderId,
  type SourceRange,
  type WorkspaceRevision,
} from "@zendev-lab/spark-lens";

import { resolvePackageBinary } from "./typescript-providers.ts";
import type { TypeScriptVerificationResult } from "./typescript-verification.ts";

interface PreflightResult {
  annotation: LensReadAnnotation;
}

interface RepairResult {
  receipt?: LensReadRepairReceipt;
  proposal?: PatchProposal;
  change?: LensWorkspaceChange;
  unchanged: boolean;
}

interface ReadVerificationService {
  diagnostics(input: {
    cwd: string;
    path?: string;
    maxFindings?: number;
  }): Promise<TypeScriptVerificationResult>;
}

interface ReadIntelligenceService {
  index(input: { revision: WorkspaceRevision; changedPaths?: readonly string[] }): Promise<unknown>;
  outline(
    revision: WorkspaceRevision,
    path: string,
  ): ReturnType<import("./code-intelligence.ts").DaemonLensCodeIntelligence["outline"]>;
}

interface ReadPatchService {
  propose: import("./patch-service.ts").DaemonLensPatchService["propose"];
  apply: import("./patch-service.ts").DaemonLensPatchService["apply"];
}

type SourceTransform = (input: {
  workspaceRoot: string;
  path: string;
  source: string;
  signal?: AbortSignal;
}) => Promise<string>;

export class DaemonLensReadIntegration {
  readonly #verification: ReadVerificationService;
  readonly #intelligence: ReadIntelligenceService;
  readonly #patches: ReadPatchService;
  readonly #formatSource: SourceTransform;
  readonly #safeFixSource: SourceTransform;
  readonly #preflights = new Map<string, Promise<PreflightResult>>();
  readonly #candidates = new Map<
    string,
    {
      workspaceRoot: string;
      path: string;
      fileVersion: FileContentVersion;
      sourceLength: number;
      content: string;
      provider: ProviderId;
      kind: LensFixKind;
    }
  >();

  constructor(options: {
    verification: ReadVerificationService;
    intelligence: ReadIntelligenceService;
    patches: ReadPatchService;
    formatSource?: SourceTransform;
    safeFixSource?: SourceTransform;
  }) {
    this.#verification = options.verification;
    this.#intelligence = options.intelligence;
    this.#patches = options.patches;
    this.#formatSource = options.formatSource ?? formatTypeScript;
    this.#safeFixSource = options.safeFixSource ?? safeLintFix;
  }

  async annotate(input: {
    workspaceRoot: string;
    path: string;
    fileVersion: FileContentVersion;
    startLine: number;
    endLine: number;
    mode: LensReadAnalysisMode;
    artifactRef?: `artifact:${string}`;
  }): Promise<LensReadAnnotation | undefined> {
    if (input.mode === "off" || !isSupportedSource(input.path)) return undefined;
    if (!isTypeScriptSource(input.path)) {
      const revision = await captureWorkspaceRevision({
        workspaceRoot: input.workspaceRoot,
        profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
      });
      return pendingAnnotation(input.fileVersion, revision, "unsupported");
    }
    const key = preflightKey(input.workspaceRoot, input.path, input.fileVersion);
    let preflight = this.#preflights.get(key);
    if (!preflight) {
      preflight = this.#runPreflight(input).catch(async () => {
        const revision = await captureWorkspaceRevision({
          workspaceRoot: input.workspaceRoot,
          profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
        });
        return { annotation: pendingAnnotation(input.fileVersion, revision, "unsupported") };
      });
      this.#preflights.set(key, preflight);
    }
    const budgetMs = input.mode === "fresh" ? 2_000 : 120;
    const settled = await settleWithin(preflight, budgetMs);
    if (settled) return settled.annotation;
    const revision = await captureWorkspaceRevision({
      workspaceRoot: input.workspaceRoot,
      profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
    });
    return {
      ...pendingAnnotation(input.fileVersion, revision, "pending"),
      checkTicketRef: `lens-check:${createHash("sha256").update(key).digest("hex")}`,
    };
  }

  async propose(input: {
    workspaceRoot?: string;
    candidateRef?: string;
    path?: string;
    kind: LensFixKind;
  }): Promise<PatchProposal> {
    if (!input.candidateRef) {
      throw new Error(`${input.kind} fix requires a Provider candidateRef`);
    }
    const candidate = this.#candidates.get(input.candidateRef);
    if (
      !candidate ||
      (input.workspaceRoot !== undefined &&
        candidate.workspaceRoot !== resolve(input.workspaceRoot))
    ) {
      throw new Error(`unknown or stale Lens fix candidate: ${input.candidateRef}`);
    }
    if (candidate.kind !== input.kind) {
      throw new Error(
        `Lens fix candidate kind mismatch: expected ${candidate.kind}, received ${input.kind}`,
      );
    }
    if (
      input.path !== undefined &&
      resolve(candidate.workspaceRoot, candidate.path) !==
        resolve(candidate.workspaceRoot, input.path)
    ) {
      throw new Error("Lens fix candidate belongs to another file");
    }
    const snapshot = await readRegularFileSnapshot(
      resolve(candidate.workspaceRoot, candidate.path),
    );
    if (snapshot.version !== candidate.fileVersion) {
      this.#candidates.delete(input.candidateRef);
      throw new Error("Lens fix candidate file version is stale");
    }
    return await this.#patches.propose({
      workspaceRoot: candidate.workspaceRoot,
      provider: candidate.provider,
      edits: [
        {
          path: candidate.path,
          startOffset: 0,
          endOffset: candidate.sourceLength,
          newText: candidate.content,
        },
      ],
      safety: { kind: "safe" },
    });
  }

  async repair(input: {
    workspaceRoot: string;
    path: string;
    expectedVersion: FileContentVersion;
    mode: Exclude<LensReadRepairMode, "none">;
    signal?: AbortSignal;
  }): Promise<RepairResult> {
    if (!isTypeScriptSource(input.path)) {
      throw new Error(
        `read repair has no fixed provider for ${extname(input.path) || "this file"}`,
      );
    }
    const absolutePath = resolve(input.workspaceRoot, input.path);
    const snapshot = await readRegularFileSnapshot(absolutePath);
    if (snapshot.version !== input.expectedVersion) {
      throw new Error(
        `read repair version conflict: expected ${input.expectedVersion}, actual ${snapshot.version}`,
      );
    }
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      snapshot.bytes,
    );
    let content = source;
    const providers: ProviderId[] = [];
    if (input.mode === "safe_fixes" || input.mode === "format_and_safe_fixes") {
      const fixed = await this.#safeFixSource({
        workspaceRoot: input.workspaceRoot,
        path: input.path,
        source: content,
        signal: input.signal,
      });
      if (fixed !== content) {
        content = fixed;
        providers.push(VITE_PLUS_CONTRIBUTOR_ID);
      }
    }
    if (input.mode === "format" || input.mode === "format_and_safe_fixes") {
      const formatted = await this.#formatSource({
        workspaceRoot: input.workspaceRoot,
        path: input.path,
        source: content,
        signal: input.signal,
      });
      if (formatted !== content) {
        content = formatted;
        providers.push(OXFMT_PROVIDER_ID);
      }
    }
    if (content === source) return { unchanged: true };
    const proposal = await this.#patches.propose({
      workspaceRoot: input.workspaceRoot,
      provider: providers.at(-1) ?? OXFMT_PROVIDER_ID,
      edits: [
        {
          path: input.path,
          startOffset: 0,
          endOffset: source.length,
          newText: content,
        },
      ],
      safety: { kind: "safe" },
    });
    const promotion = await this.#patches.apply({
      workspaceRoot: input.workspaceRoot,
      proposalRef: proposal.ref,
      signal: input.signal,
    });
    const promoted = await readRegularFileSnapshot(absolutePath);
    const change: LensWorkspaceChange = {
      path: input.path,
      previousVersion: input.expectedVersion,
      version: promoted.version,
      changedRanges: [
        sourceRange(0, Math.max(source.split("\n").length, content.split("\n").length) - 1),
      ],
      source: "read_repair",
    };
    this.invalidate(change);
    return {
      proposal,
      change,
      unchanged: false,
      receipt: {
        proposalRef: proposal.ref,
        providers,
        previousVersion: input.expectedVersion,
        version: promoted.version,
        revisionDigest: promotion.promotedRevision.digest,
        verificationVerdict: promotion.verdict,
      },
    };
  }

  invalidate(change: LensWorkspaceChange): void {
    for (const key of this.#preflights.keys()) {
      const [workspaceRoot, path] = key.split("\0");
      if (
        workspaceRoot &&
        path &&
        resolve(workspaceRoot, path) === resolve(workspaceRoot, change.path)
      ) {
        this.#preflights.delete(key);
      }
    }
    for (const [candidateRef, candidate] of this.#candidates) {
      if (
        resolve(candidate.workspaceRoot, candidate.path) ===
        resolve(candidate.workspaceRoot, change.path)
      ) {
        this.#candidates.delete(candidateRef);
      }
    }
  }

  invalidateAll(): void {
    this.#preflights.clear();
    this.#candidates.clear();
  }

  async #runPreflight(input: {
    workspaceRoot: string;
    path: string;
    fileVersion: FileContentVersion;
    startLine: number;
    endLine: number;
    artifactRef?: `artifact:${string}`;
  }): Promise<PreflightResult> {
    const relativePath = workspaceRelative(input.workspaceRoot, input.path);
    const source = await readFile(resolve(input.workspaceRoot, relativePath), "utf8");
    const [diagnostics, formatted, safelyFixed] = await Promise.all([
      this.#verification.diagnostics({
        cwd: input.workspaceRoot,
        path: relativePath,
        maxFindings: 100,
      }),
      isTypeScriptSource(relativePath)
        ? this.#formatSource({
            workspaceRoot: input.workspaceRoot,
            path: relativePath,
            source,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      isTypeScriptSource(relativePath)
        ? this.#safeFixSource({
            workspaceRoot: input.workspaceRoot,
            path: relativePath,
            source,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const revision = diagnostics.report.revision;
    const current = await readRegularFileSnapshot(resolve(input.workspaceRoot, relativePath));
    if (current.version !== input.fileVersion) {
      return { annotation: pendingAnnotation(input.fileVersion, revision, "stale") };
    }
    let enclosing;
    let recommendedReads: LensReadAnnotation["recommendedReads"] = [];
    try {
      await this.#intelligence.index({ revision, changedPaths: [relativePath] });
      const symbols = this.#intelligence.outline(revision, relativePath);
      const symbol = [...symbols]
        .filter(
          (candidate) =>
            candidate.startLine <= input.startLine - 1 && candidate.endLine >= input.startLine - 1,
        )
        .sort(
          (left, right) => left.endLine - left.startLine - (right.endLine - right.startLine),
        )[0];
      recommendedReads = symbols.slice(0, 3).map((candidate) => ({
        ...candidate.read,
        ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
        fileVersion: input.fileVersion,
        revisionDigest: revision.digest,
        reason: candidate === symbol ? "smallest enclosing symbol" : "file outline",
      }));
      if (symbol) {
        enclosing = {
          ...symbol.read,
          ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
          fileVersion: input.fileVersion,
          revisionDigest: revision.digest,
          reason: "smallest enclosing symbol",
          symbol: {
            name: symbol.name,
            kind: symbol.kind,
            range: sourceRange(symbol.startLine, symbol.endLine),
          },
        };
      }
    } catch {
      // Diagnostics remain useful when the optional syntax index is unavailable.
    }
    const observations = diagnostics.report.observations.filter(
      (observation) =>
        observation.subject.path === undefined ||
        workspaceRelative(input.workspaceRoot, observation.subject.path) === relativePath,
    );
    const summaries = observationSummaries(observations, source);
    const inRange = summaries
      .filter((summary) => {
        const line = summary.range?.start.line;
        return line === undefined || (line >= input.startLine - 1 && line <= input.endLine - 1);
      })
      .sort(severityOrder);
    const visible = inRange
      .filter((finding) => finding.severity === "blocker" || finding.severity === "error")
      .slice(0, 3);
    visible.push(...inRange.filter((finding) => finding.severity === "warning").slice(0, 2));
    const elsewhere = summaries.filter((summary) => !inRange.includes(summary));
    const fixes: LensReadAnnotation["fixes"][number][] = [];
    let formatCandidateRef: string | undefined;
    if (formatted !== undefined && formatted !== source) {
      formatCandidateRef = `lens-fix:${createHash("sha256")
        .update(`${revision.digest}\0${relativePath}\0format\0${formatted}`)
        .digest("hex")}`;
      this.#candidates.set(formatCandidateRef, {
        workspaceRoot: resolve(input.workspaceRoot),
        path: relativePath,
        fileVersion: input.fileVersion,
        sourceLength: source.length,
        content: formatted,
        provider: OXFMT_PROVIDER_ID,
        kind: "format",
      });
      fixes.push({
        candidateRef: formatCandidateRef,
        kind: "format",
        title: "Format this exact file version with Oxfmt",
        safe: true,
      });
    }
    if (safelyFixed !== undefined && safelyFixed !== source) {
      const candidateRef = `lens-fix:${createHash("sha256")
        .update(`${revision.digest}\0${relativePath}\0safe-fixes\0${safelyFixed}`)
        .digest("hex")}`;
      this.#candidates.set(candidateRef, {
        workspaceRoot: resolve(input.workspaceRoot),
        path: relativePath,
        fileVersion: input.fileVersion,
        sourceLength: source.length,
        content: safelyFixed,
        provider: VITE_PLUS_CONTRIBUTOR_ID,
        kind: "quickfix",
      });
      fixes.push({
        candidateRef,
        kind: "quickfix",
        title: "Apply deterministic safe lint fixes to this exact file version",
        safe: true,
      });
    }
    const status =
      diagnostics.report.verdict === "stale"
        ? "stale"
        : diagnostics.report.verdict === "inconclusive"
          ? "partial"
          : "complete";
    return {
      annotation: {
        fileVersion: input.fileVersion,
        revisionDigest: diagnostics.report.revision.digest,
        status,
        ...(enclosing ? { enclosing } : {}),
        recommendedReads,
        diagnostics: {
          inRange: visible,
          elsewhere: {
            errors: elsewhere.filter(
              (finding) => finding.severity === "error" || finding.severity === "blocker",
            ).length,
            warnings: elsewhere.filter((finding) => finding.severity === "warning").length,
          },
          authoritativeClean:
            diagnostics.report.verdict === "pass" && diagnostics.report.observations.length === 0,
        },
        format:
          formatted === undefined
            ? { status: "unavailable" }
            : formatted === source
              ? { status: "clean" }
              : { status: "changes_available", candidateRef: formatCandidateRef! },
        fixes,
      },
    };
  }
}

async function formatTypeScript(input: {
  workspaceRoot: string;
  path: string;
  source: string;
  signal?: AbortSignal;
}): Promise<string> {
  const binary = await resolvePackageBinary(input.workspaceRoot, "vite-plus", "vp");
  const result = await run(
    binary.command,
    [...binary.argsPrefix, "fmt", "--stdin-filepath", resolve(input.workspaceRoot, input.path)],
    input.workspaceRoot,
    input.source,
    input.signal,
  );
  if (result.code !== 0) throw new Error(result.stderr || "Oxfmt failed");
  return result.stdout;
}

async function safeLintFix(input: {
  workspaceRoot: string;
  path: string;
  source: string;
  signal?: AbortSignal;
}): Promise<string> {
  const binary = await resolvePackageBinary(input.workspaceRoot, "vite-plus", "vp");
  const root = await mkdtemp(resolve(tmpdir(), "spark-lens-safe-fix-"));
  const tempPath = resolve(root, input.path.replaceAll(/[\\/]/gu, "__"));
  try {
    await writeFile(tempPath, input.source, "utf8");
    const result = await run(
      binary.command,
      [...binary.argsPrefix, "lint", "--fix", "--no-ignore", tempPath],
      input.workspaceRoot,
      undefined,
      input.signal,
    );
    requireSuccessfulProviderRun(result, "Vite+ safe lint fix");
    return await readFile(tempPath, "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function requireSuccessfulProviderRun(
  result: { code: number; stderr: string },
  provider: string,
): void {
  if (result.code === 0) return;
  throw new Error(result.stderr.trim() || `${provider} failed with exit code ${result.code}`);
}

function observationSummaries(
  observations: readonly Observation[],
  source: string,
): LensReadAnnotation["diagnostics"]["inRange"] {
  const lines = source.split("\n");
  return observations.map((observation) => {
    const line = observation.subject.range?.start.line;
    const code = observation.observations.find((entry) => entry.code)?.code;
    return {
      ref: observation.ref,
      severity: observation.severity,
      path: observation.subject.path ?? "",
      ...(observation.subject.range ? { range: observation.subject.range } : {}),
      ...(code ? { code } : {}),
      message: observation.summary,
      sources: observation.observations.map((entry) => entry.providerId),
      ...(line === undefined || lines[line] === undefined
        ? {}
        : { snippet: lines[line]!.trim().slice(0, 160) }),
      fixable: false,
    };
  });
}

function severityOrder(
  left: LensReadAnnotation["diagnostics"]["inRange"][number],
  right: LensReadAnnotation["diagnostics"]["inRange"][number],
): number {
  const order = { blocker: 0, error: 1, warning: 2, info: 3 } as const;
  return order[left.severity] - order[right.severity];
}

function pendingAnnotation(
  fileVersion: FileContentVersion,
  revision: WorkspaceRevision,
  status: "pending" | "unsupported" | "stale",
): LensReadAnnotation {
  return {
    fileVersion,
    revisionDigest: revision.digest,
    status,
    recommendedReads: [],
    diagnostics: {
      inRange: [],
      elsewhere: { errors: 0, warnings: 0 },
      authoritativeClean: false,
    },
    format: { status: status === "pending" ? "pending" : "unavailable" },
    fixes: [],
  };
}

function sourceRange(startLine: number, endLine: number): SourceRange {
  return {
    start: { line: startLine, character: 0 },
    end: { line: endLine, character: 0 },
  };
}

function workspaceRelative(workspaceRoot: string, path: string): string {
  const absolute = resolve(workspaceRoot, path);
  const relation = relative(resolve(workspaceRoot), absolute).replaceAll("\\", "/");
  if (relation === ".." || relation.startsWith("../")) {
    throw new Error(`Lens path escapes workspace: ${path}`);
  }
  return relation;
}

function preflightKey(workspaceRoot: string, path: string, version: FileContentVersion): string {
  return `${resolve(workspaceRoot)}\0${workspaceRelative(workspaceRoot, path)}\0${version}`;
}

function isTypeScriptSource(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].includes(extname(path));
}

function isSupportedSource(path: string): boolean {
  return isTypeScriptSource(path) || [".py", ".rs"].includes(extname(path));
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  const timeout = new Promise<undefined>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(undefined), timeoutMs);
    timer.unref?.();
  });
  return await Promise.race([promise, timeout]);
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  stdin?: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      signal,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const append = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error("Lens provider output exceeded 8 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout!.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr!.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}
