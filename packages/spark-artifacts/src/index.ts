import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  sparkWorkspaceStatePath,
  writeJsonFileAtomic,
  writeTextFileAtomic,
  type SparkStateRootContext,
} from "@zendev-lab/spark-core";
import { isArtifactKind } from "./artifact/types.ts";

export { writeJsonFileAtomic, writeTextFileAtomic };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type EvidenceRef = `evidence:${string}` & { readonly __kind?: "evidence" };
export type ProjectRef = `proj:${string}` & { readonly __kind?: "proj" };
export type TaskRef = `task:${string}` & { readonly __kind?: "task" };
export type RoleRef = `role:${string}` & { readonly __kind?: "role" };
export type RunRef = `run:${string}` & { readonly __kind?: "run" };
export type ReviewRef = `review:${string}` & { readonly __kind?: "review" };
export type AskRef = `ask:${string}` & { readonly __kind?: "ask" };
export type CueJobRef = `cue-job:${string}` & { readonly __kind?: "cue-job" };
export type LinkableRef =
  | EvidenceRef
  | ProjectRef
  | TaskRef
  | RoleRef
  | RunRef
  | ReviewRef
  | AskRef
  | CueJobRef;

export type EvidenceProducer = "spark" | "role" | "task" | "review" | "ask" | "cue" | "user";

export const EVIDENCE_PRODUCERS = [
  "spark",
  "role",
  "task",
  "review",
  "ask",
  "cue",
  "user",
] as const satisfies readonly EvidenceProducer[];

export interface EvidenceProvenance {
  producer: EvidenceProducer;
  runRef?: RunRef;
  projectRef?: ProjectRef;
  taskRef?: TaskRef;
  roleRef?: RoleRef;
  parentEvidenceRefs?: EvidenceRef[];
  note?: string;
}

/**
 * Agent-internal evidence kinds (not Hub/user content). Artifacts are
 * issue|git_change|document in `./artifact/`.
 *
 * Prefer compact JSON `record` notes. Keep `trace` for prunable raw output.
 * `knowledge` is owned by the learning capability; `document` is rare long prose.
 */
export type EvidenceKind = "document" | "record" | "trace" | "knowledge";

export const EVIDENCE_KINDS = [
  "document",
  "record",
  "trace",
  "knowledge",
] as const satisfies readonly EvidenceKind[];

export type EvidenceFormat = "markdown" | "json" | "text";

export const EVIDENCE_FORMATS = [
  "markdown",
  "json",
  "text",
] as const satisfies readonly EvidenceFormat[];

export type EvidenceCurationStatus = "raw" | "candidate" | "curated" | "archived" | "superseded";

export const EVIDENCE_CURATION_STATUSES = [
  "raw",
  "candidate",
  "curated",
  "archived",
  "superseded",
] as const satisfies readonly EvidenceCurationStatus[];

export type EvidenceRetention = "ephemeral" | "task" | "project" | "durable";

export const EVIDENCE_RETENTIONS = [
  "ephemeral",
  "task",
  "project",
  "durable",
] as const satisfies readonly EvidenceRetention[];

export interface EvidenceCuration {
  /** Lifecycle for keeping only the useful Evidence essence visible by default. */
  status: EvidenceCurationStatus;
  /** Intended retention horizon; storage owners may use it for sweeps. */
  retention?: EvidenceRetention;
  /** Human-readable justification for promotion, archive, or supersession. */
  reason?: string;
  /** Raw/candidate Evidence records folded into this curated record. */
  promotedFrom?: EvidenceRef[];
  /** Better Evidence records that replace this one. */
  supersededBy?: EvidenceRef[];
  /** Essence/summary Evidence record that compacted this record. */
  compactedInto?: EvidenceRef;
  /** Optional expiry for raw/ephemeral Evidence. */
  expiresAt?: string;
}

export interface EvidenceTranscriptRetention {
  schemaVersion: 1;
  strategy: "role-run-compact-summary-tail";
  candidateReason: string;
  originalBlobPath?: string;
  originalHash?: string;
  originalBodySize?: number;
  originalMetadataBytes?: number;
  replacementSummary: string;
  transcriptTail?: {
    bytes: number;
    tailBytes: number;
    truncated: boolean;
    source: "serialized-evidence-body-tail";
    tail: string;
  };
  exportPath?: string;
  compactedAt: string;
  fullTranscriptDeletedAt?: string;
}

export interface EvidenceRecord<T extends JsonValue | string = JsonValue | string> {
  ref: EvidenceRef;
  kind: EvidenceKind;
  title: string;
  format: EvidenceFormat;
  body: T;
  /** Bounded serialized body preview when metadata body is stored out-of-line. */
  bodyPreview?: string;
  /** Serialized body byte size when known. */
  bodySize?: number;
  /** True when `body` contains only a preview and `blobPath` is the body source. */
  bodyTruncated?: boolean;
  /** Curation lifecycle used to keep raw evidence from overwhelming default views/search. */
  curation?: EvidenceCuration;
  /** Audit metadata for historical transcript blob replacement. */
  transcriptRetention?: EvidenceTranscriptRetention;
  hash?: string;
  blobPath?: string;
  links: EvidenceLink[];
  provenance: EvidenceProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceLink {
  from: EvidenceRef;
  to: LinkableRef;
  relation: "parent" | "input" | "output" | "review-of" | "answer-to" | "trace-of" | "derived-from";
}

export const EVIDENCE_LINK_RELATIONS = [
  "parent",
  "input",
  "output",
  "review-of",
  "answer-to",
  "trace-of",
  "derived-from",
] as const satisfies readonly EvidenceLink["relation"][];

export interface PutEvidenceInput<T extends JsonValue | string = JsonValue | string> {
  kind: EvidenceKind;
  title: string;
  format: EvidenceFormat;
  body: T;
  provenance: EvidenceProvenance;
  links?: Omit<EvidenceLink, "from">[];
  curation?: EvidenceCuration;
  ref?: EvidenceRef;
}

export interface EvidenceStoreOptions {
  rootDir: string;
  inlineBodyThresholdBytes?: number;
  bodyPreviewChars?: number;
}

export interface EvidenceQuery {
  kind?: EvidenceKind;
  projectRef?: string;
  taskRef?: string;
  roleRef?: string;
  producer?: EvidenceProvenance["producer"];
  linkedTo?: string;
  curationStatus?: EvidenceCurationStatus | EvidenceCurationStatus[];
  retention?: EvidenceRetention;
  /** Defaults are caller-owned; when false, Evidence explicitly marked raw is hidden. */
  includeRaw?: boolean;
  /** Defaults are caller-owned; when false, archived/superseded Evidence is hidden. */
  includeArchived?: boolean;
}

export interface EvidenceMetadataCompactionOptions {
  /** Defaults to true so callers must opt in before rewriting metadata files. */
  dryRun?: boolean;
  inlineBodyThresholdBytes?: number;
  bodyPreviewChars?: number;
}

export interface EvidenceMetadataCompactionCandidate {
  ref: EvidenceRef;
  path: string;
  blobPath: string;
  metadataBytesBefore: number;
  metadataBytesAfter: number;
  bodyBytes: number;
  reclaimableBytes: number;
}

export interface EvidenceMetadataCompactionSkipped {
  path: string;
  reason:
    | "already_compacted"
    | "invalid_json"
    | "invalid_metadata"
    | "invalid_blob_path"
    | "missing_blob_path"
    | "missing_blob"
    | "hash_mismatch"
    | "small_body";
  message?: string;
}

export interface EvidenceMetadataCompactionResult {
  dryRun: boolean;
  scanned: number;
  compacted: number;
  skipped: EvidenceMetadataCompactionSkipped[];
  candidates: EvidenceMetadataCompactionCandidate[];
  metadataBytesBefore: number;
  metadataBytesAfter: number;
  reclaimableBytes: number;
}

export interface EvidenceListDiagnostic {
  filePath: string;
  message: string;
  reason?: string;
}

export interface EvidenceListWithDiagnosticsResult {
  evidence: EvidenceRecord[];
  diagnostics: EvidenceListDiagnostic[];
}

type EvidenceStoreFormatReason = "invalid_json" | "invalid_metadata";

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceValidationError";
  }
}

export class EvidenceStoreFormatError extends Error {
  readonly filePath: string;
  readonly reason: EvidenceStoreFormatReason;

  constructor(
    filePath: string,
    message: string,
    reason: EvidenceStoreFormatReason = "invalid_metadata",
  ) {
    super(`${filePath}: ${message}`);
    this.name = "EvidenceStoreFormatError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

const DEFAULT_INLINE_BODY_THRESHOLD_BYTES = 64 * 1024;
const DEFAULT_BODY_PREVIEW_CHARS = 4_000;

const LEGACY_EVIDENCE_KIND_MAP: Readonly<Record<string, EvidenceKind>> = {
  "agent-plan": "document",
  "ask-answer": "record",
  "cue-output": "trace",
  review: "record",
  "role-plan": "document",
  "run-trace": "trace",
  "spark-md": "document",
  validation: "record",
  verification: "record",
};

export function canonicalEvidenceKindForPersistedKind(value: unknown): EvidenceKind | undefined {
  if (typeof value !== "string") return undefined;
  if (isEvidenceKind(value)) return value;
  return LEGACY_EVIDENCE_KIND_MAP[value];
}

export class EvidenceStore {
  readonly rootDir: string;
  readonly blobDir: string;
  readonly inlineBodyThresholdBytes: number;
  readonly bodyPreviewChars: number;

  constructor(options: EvidenceStoreOptions) {
    this.rootDir = options.rootDir;
    this.blobDir = join(options.rootDir, "blobs");
    this.inlineBodyThresholdBytes =
      options.inlineBodyThresholdBytes ?? DEFAULT_INLINE_BODY_THRESHOLD_BYTES;
    this.bodyPreviewChars = options.bodyPreviewChars ?? DEFAULT_BODY_PREVIEW_CHARS;
  }

  async put<T extends JsonValue | string>(input: PutEvidenceInput<T>): Promise<EvidenceRecord<T>> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.blobDir, { recursive: true });
    const now = nowIso();
    const ref = input.ref ?? newEvidenceRef();
    this.assertEvidenceRef(ref, "ref");
    const existing = input.ref ? await this.tryGet<T>(input.ref) : null;
    const parentLinks: EvidenceLink[] = (input.provenance.parentEvidenceRefs ?? []).map(
      (parent) => ({
        from: ref,
        to: parent,
        relation: "parent",
      }),
    );
    const evidence: EvidenceRecord<T> = {
      ref,
      kind: input.kind,
      title: input.title,
      format: input.format,
      body: input.body,
      links: [...parentLinks, ...(input.links ?? []).map((link) => ({ ...link, from: ref }))],
      provenance: input.provenance,
      curation:
        input.curation ??
        existing?.curation ??
        defaultEvidenceCuration(input.kind, input.provenance),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    validateEvidenceRecord(evidence);

    const serializedBody = serializeEvidenceBody(input.format, input.body);
    const hash = contentHash(serializedBody);
    const blobPath = join("blobs", `${hash}.${extensionForFormat(input.format)}`);
    const storedEvidence: EvidenceRecord<T> = {
      ...evidence,
      body: metadataBodyFor(input.body, serializedBody, {
        thresholdBytes: this.inlineBodyThresholdBytes,
        previewChars: this.bodyPreviewChars,
      }),
      hash,
      blobPath,
    };
    addBodyCompactionMetadata(storedEvidence, serializedBody, {
      thresholdBytes: this.inlineBodyThresholdBytes,
      previewChars: this.bodyPreviewChars,
    });
    validateEvidenceRecord(storedEvidence);
    await writeTextFileAtomic(join(this.rootDir, blobPath), serializedBody);
    await writeJsonFileAtomic(this.pathFor(ref), storedEvidence);
    return { ...storedEvidence, body: input.body };
  }

  async update<T extends JsonValue | string>(
    ref: EvidenceRef,
    patch: Partial<Omit<PutEvidenceInput<T>, "ref">>,
  ): Promise<EvidenceRecord<T>> {
    this.assertEvidenceRef(ref, "ref");
    const existing = await this.get<T>(ref);
    return this.put<T>({
      ref,
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      format: patch.format ?? existing.format,
      body: patch.body ?? existing.body,
      provenance: patch.provenance ?? existing.provenance,
      links: patch.links ?? existing.links.map(({ from: _from, ...link }) => link),
      curation: patch.curation ?? existing.curation,
    });
  }

  async get<T extends JsonValue | string = JsonValue | string>(
    ref: EvidenceRef,
  ): Promise<EvidenceRecord<T>> {
    this.assertEvidenceRef(ref, "ref");
    const evidence = await this.readMetadata<T>(ref);
    if (evidence.blobPath) {
      const body = await this.getBody(ref);
      return {
        ...evidence,
        body: parseEvidenceBody(evidence.format, body) as T,
      };
    }
    return evidence;
  }

  async getBody(ref: EvidenceRef): Promise<string> {
    this.assertEvidenceRef(ref, "ref");
    const evidence = await this.readMetadata(ref);
    if (evidence.blobPath) {
      const blobPath = resolveEvidenceBlobPath(this.rootDir, evidence.blobPath);
      if (blobPath) {
        try {
          const bodyBytes = await readFile(blobPath);
          assertEvidenceBodyIntegrity(evidence, bodyBytes);
          return bodyBytes.toString("utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      throw new Error(`evidence blob path is unavailable in evidence store: ${evidence.ref}`);
    }
    const serializedBody = serializeEvidenceBody(evidence.format, evidence.body);
    assertEvidenceBodyIntegrity(evidence, serializedBody);
    return serializedBody;
  }

  async tryGet<T extends JsonValue | string = JsonValue | string>(
    ref: EvidenceRef,
  ): Promise<EvidenceRecord<T> | null> {
    try {
      return await this.get<T>(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: EvidenceQuery = {}): Promise<EvidenceRecord[]> {
    const { evidence, diagnostics } = await this.listWithDiagnostics(filter);
    const fatal = diagnostics.find((diagnostic) => diagnostic.reason !== undefined);
    if (fatal) {
      throw new EvidenceStoreFormatError(
        fatal.filePath,
        fatal.message.replace(`${fatal.filePath}: `, ""),
        (fatal.reason as "invalid_json" | "invalid_metadata") ?? "invalid_metadata",
      );
    }
    if (diagnostics.length > 0) {
      throw new EvidenceStoreFormatError(
        diagnostics[0]!.filePath,
        diagnostics[0]!.message.replace(`${diagnostics[0]!.filePath}: `, ""),
        "invalid_metadata",
      );
    }
    return evidence;
  }

  async listWithDiagnostics(
    filter: EvidenceQuery = {},
  ): Promise<EvidenceListWithDiagnosticsResult> {
    await mkdir(this.rootDir, { recursive: true });
    const evidence: EvidenceRecord[] = [];
    const diagnostics: EvidenceListDiagnostic[] = [];
    let entries;
    try {
      entries = await readdir(this.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { evidence, diagnostics };
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = join(this.rootDir, entry.name);
      let evidenceRecord: EvidenceRecord;
      try {
        const metadata = await readEvidenceMetadataFile(filePath);
        if (!this.acceptsRef(metadata.ref)) {
          diagnostics.push({
            filePath,
            reason: "invalid_metadata",
            message: `${filePath}: evidence store cannot read ${metadata.ref}`,
          });
          continue;
        }
        evidenceRecord = await this.get(metadata.ref);
      } catch (error) {
        diagnostics.push(evidenceListDiagnostic(filePath, error));
        continue;
      }
      if (!matchesQuery(evidenceRecord, filter)) continue;
      evidence.push(evidenceRecord);
    }
    return {
      evidence: evidence.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      diagnostics,
    };
  }

  async linksTo(targetRef: string): Promise<EvidenceLink[]> {
    const evidenceRecords = await this.list({ linkedTo: targetRef });
    return evidenceRecords.flatMap((evidence) =>
      evidence.links.filter((link) => link.to === targetRef),
    );
  }

  async diff(
    left: EvidenceRef,
    right: EvidenceRef,
  ): Promise<{ same: boolean; leftHash?: string; rightHash?: string }> {
    const leftEvidence = await this.get(left);
    const rightEvidence = await this.get(right);
    return {
      same: leftEvidence.hash === rightEvidence.hash,
      leftHash: leftEvidence.hash,
      rightHash: rightEvidence.hash,
    };
  }

  async compactMetadata(
    options: EvidenceMetadataCompactionOptions = {},
  ): Promise<EvidenceMetadataCompactionResult> {
    return compactEvidenceMetadata(this.rootDir, {
      inlineBodyThresholdBytes: options.inlineBodyThresholdBytes ?? this.inlineBodyThresholdBytes,
      bodyPreviewChars: options.bodyPreviewChars ?? this.bodyPreviewChars,
      dryRun: options.dryRun,
    });
  }

  pathFor(ref: EvidenceRef): string {
    this.assertEvidenceRef(ref, "ref");
    return join(this.rootDir, `${refId(ref)}.json`);
  }

  private acceptsRef(ref: string): boolean {
    return ref.startsWith("evidence:") && ref.length > "evidence:".length;
  }

  private assertEvidenceRef(ref: string, label: string): void {
    if (!this.acceptsRef(ref)) {
      throw new EvidenceValidationError(`${label} must be an evidence: ref for the evidence store`);
    }
  }

  private async readMetadata<T extends JsonValue | string = JsonValue | string>(
    ref: EvidenceRef,
  ): Promise<EvidenceRecord<T>> {
    return (await readEvidenceMetadataFile(this.pathFor(ref))) as EvidenceRecord<T>;
  }
}

function evidenceListDiagnostic(filePath: string, error: unknown): EvidenceListDiagnostic {
  if (error instanceof EvidenceStoreFormatError) {
    return { filePath: error.filePath, reason: error.reason, message: error.message };
  }
  return { filePath, message: unknownErrorMessage(error) };
}

/**
 * Internal evidence store used by the `evidence` tool. New writes go to
 * `.spark/evidence`. Artifact issue/git_change/document live under `.spark/artifacts`
 * and are never scanned by this store.
 */
export function defaultEvidenceStore(cwd: string, ctx?: SparkStateRootContext): EvidenceStore {
  return new EvidenceStore({ rootDir: sparkWorkspaceStatePath(cwd, ["evidence"], ctx) });
}

export async function readEvidenceMetadataFile(filePath: string): Promise<EvidenceRecord> {
  const text = await readFile(filePath, "utf8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new EvidenceStoreFormatError(
      filePath,
      `invalid JSON: ${unknownErrorMessage(error)}`,
      "invalid_json",
    );
  }
  const metadata = normalizePersistedEvidenceMetadata(raw);
  try {
    validateEvidenceRecord(metadata);
  } catch (error) {
    throw new EvidenceStoreFormatError(filePath, unknownErrorMessage(error));
  }
  return metadata;
}

function normalizePersistedEvidenceMetadata(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const canonicalKind = canonicalEvidenceKindForPersistedKind(raw.kind);
  if (!canonicalKind || canonicalKind === raw.kind) return raw;
  return {
    ...raw,
    kind: canonicalKind,
    legacyKind: raw.kind,
  };
}

export function resolveEvidenceBlobPath(rootDir: string, blobPath: string): string | undefined {
  if (!blobPath.trim() || blobPath.includes("\0") || isAbsolute(blobPath)) return undefined;
  const root = resolve(rootDir);
  const blobRoot = resolve(root, "blobs");
  const resolved = resolve(root, blobPath);
  const scoped = relative(blobRoot, resolved);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) return undefined;
  return resolved;
}

export async function compactEvidenceMetadata(
  rootDir: string,
  options: EvidenceMetadataCompactionOptions = {},
): Promise<EvidenceMetadataCompactionResult> {
  await mkdir(rootDir, { recursive: true });
  const dryRun = options.dryRun ?? true;
  const thresholdBytes = options.inlineBodyThresholdBytes ?? DEFAULT_INLINE_BODY_THRESHOLD_BYTES;
  const previewChars = options.bodyPreviewChars ?? DEFAULT_BODY_PREVIEW_CHARS;
  const entries = await readdir(rootDir, { withFileTypes: true });
  const result: EvidenceMetadataCompactionResult = {
    dryRun,
    scanned: 0,
    compacted: 0,
    skipped: [],
    candidates: [],
    metadataBytesBefore: 0,
    metadataBytesAfter: 0,
    reclaimableBytes: 0,
  };
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(rootDir, entry.name);
    result.scanned += 1;
    const metadataBytesBefore = await fileSize(path);
    result.metadataBytesBefore += metadataBytesBefore;
    let evidence: EvidenceRecord;
    try {
      evidence = await readEvidenceMetadataFile(path);
    } catch (error) {
      if (error instanceof EvidenceStoreFormatError) {
        result.skipped.push({
          path,
          reason: error.reason,
          message: error.message,
        });
      } else {
        result.skipped.push({
          path,
          reason: "invalid_json",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    if (evidence.bodyTruncated) {
      result.skipped.push({ path, reason: "already_compacted" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    if (!evidence.blobPath) {
      result.skipped.push({ path, reason: "missing_blob_path" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    const blobPath = resolveEvidenceBlobPath(rootDir, evidence.blobPath);
    if (!blobPath) {
      result.skipped.push({ path, reason: "invalid_blob_path" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    let blobText: string;
    try {
      blobText = await readFile(blobPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result.skipped.push({ path, reason: "missing_blob" });
        result.metadataBytesAfter += metadataBytesBefore;
        continue;
      }
      throw error;
    }
    if (evidence.hash && contentHash(blobText) !== evidence.hash) {
      result.skipped.push({ path, reason: "hash_mismatch" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    if (Buffer.byteLength(blobText, "utf8") <= thresholdBytes) {
      result.skipped.push({ path, reason: "small_body" });
      result.metadataBytesAfter += metadataBytesBefore;
      continue;
    }
    const compactedEvidence = compactStoredEvidence(evidence, blobText, {
      thresholdBytes,
      previewChars,
    });
    const compactedText = `${JSON.stringify(compactedEvidence, null, 2)}\n`;
    const metadataBytesAfter = Buffer.byteLength(compactedText, "utf8");
    const candidate: EvidenceMetadataCompactionCandidate = {
      ref: evidence.ref,
      path,
      blobPath: evidence.blobPath,
      metadataBytesBefore,
      metadataBytesAfter,
      bodyBytes: Buffer.byteLength(blobText, "utf8"),
      reclaimableBytes: Math.max(0, metadataBytesBefore - metadataBytesAfter),
    };
    result.candidates.push(candidate);
    result.metadataBytesAfter += metadataBytesAfter;
    result.reclaimableBytes += candidate.reclaimableBytes;
    if (!dryRun) {
      await writeTextFileAtomic(path, compactedText);
      result.compacted += 1;
    }
  }
  return result;
}

export function validateEvidenceRecord(evidence: unknown): asserts evidence is EvidenceRecord {
  if (!isRecord(evidence)) throw new EvidenceValidationError("evidence metadata must be an object");
  assertEvidenceRefValue(evidence.ref, "evidence ref");
  if (!isEvidenceKind(evidence.kind)) {
    throw new EvidenceValidationError("kind must be a valid Evidence kind");
  }
  assertNonEmpty(evidence.title, "Evidence title");
  if (!isEvidenceFormat(evidence.format)) {
    throw new EvidenceValidationError(`invalid Evidence format: ${String(evidence.format)}`);
  }
  if (!isJsonValue(evidence.body)) {
    throw new EvidenceValidationError("body must be a JSON value");
  }
  assertOptionalNonEmptyString(evidence.bodyPreview, "bodyPreview");
  assertOptionalPositiveNumber(evidence.bodySize, "bodySize");
  assertOptionalBoolean(evidence.bodyTruncated, "bodyTruncated");
  assertOptionalNonEmptyString(evidence.hash, "hash");
  assertOptionalNonEmptyString(evidence.blobPath, "blobPath");
  if (evidence.bodyTruncated === true) {
    assertNonEmpty(evidence.bodyPreview, "bodyPreview");
    assertPositiveNumber(evidence.bodySize, "bodySize");
    assertNonEmpty(evidence.blobPath, "blobPath");
  }
  if (evidence.curation !== undefined) validateEvidenceCuration(evidence.curation);
  if (evidence.transcriptRetention !== undefined) {
    validateEvidenceTranscriptRetention(evidence.transcriptRetention);
  }
  if (!Array.isArray(evidence.links)) throw new EvidenceValidationError("links must be an array");
  evidence.links.forEach((link, index) => validateEvidenceLink(link, index));
  validateEvidenceProvenance(evidence.provenance);
  assertNonEmpty(evidence.createdAt, "createdAt");
  assertNonEmpty(evidence.updatedAt, "updatedAt");
}

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return EVIDENCE_KINDS.includes(value as EvidenceKind);
}

export function isEvidenceFormat(value: unknown): value is EvidenceFormat {
  return EVIDENCE_FORMATS.includes(value as EvidenceFormat);
}

export function isEvidenceCurationStatus(value: unknown): value is EvidenceCurationStatus {
  return EVIDENCE_CURATION_STATUSES.includes(value as EvidenceCurationStatus);
}

export function isEvidenceRetention(value: unknown): value is EvidenceRetention {
  return EVIDENCE_RETENTIONS.includes(value as EvidenceRetention);
}

export function isEvidenceLinkRelation(value: unknown): value is EvidenceLink["relation"] {
  return EVIDENCE_LINK_RELATIONS.includes(value as EvidenceLink["relation"]);
}

export function isEvidenceProducer(value: unknown): value is EvidenceProducer {
  return EVIDENCE_PRODUCERS.includes(value as EvidenceProducer);
}

export function newEvidenceRef(id: string = randomUUID()): EvidenceRef {
  if (!id || id.includes(":")) throw new EvidenceValidationError(`invalid evidence id: ${id}`);
  return `evidence:${id}` as EvidenceRef;
}

function assertEvidenceRefValue(value: unknown, label: string): void {
  assertRefValue(value, "evidence", label);
}

export function refId(ref: string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new EvidenceValidationError(`invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

export function contentHash(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function assertEvidenceBodyIntegrity(
  evidence: Pick<EvidenceRecord, "ref" | "hash" | "blobPath">,
  serializedBody: string | Uint8Array,
): void {
  const actualHash = contentHash(serializedBody);
  if (evidence.blobPath && evidence.hash === undefined) {
    throw new EvidenceValidationError(`evidence blob metadata hash is missing: ${evidence.ref}`);
  }
  if (evidence.hash !== undefined && evidence.hash !== actualHash) {
    throw new EvidenceValidationError(`evidence body hash mismatch: ${evidence.ref}`);
  }
  if (evidence.blobPath && basename(evidence.blobPath).split(".", 1)[0] !== actualHash) {
    throw new EvidenceValidationError(`evidence blob path hash mismatch: ${evidence.ref}`);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultEvidenceCuration(
  kind: EvidenceKind,
  provenance: EvidenceProvenance,
): EvidenceCuration {
  if (kind === "knowledge") return { status: "curated", retention: "durable" };
  if (kind === "trace") return { status: "raw", retention: "ephemeral" };
  if (provenance.producer === "review") return { status: "raw", retention: "task" };
  if (provenance.producer === "user") return { status: "candidate", retention: "project" };
  if (kind === "document") return { status: "candidate", retention: "project" };
  return { status: "raw", retention: "task" };
}

function validateEvidenceLink(link: unknown, index: number): void {
  if (!isRecord(link)) throw new EvidenceValidationError(`links[${index}] must be an object`);
  assertEvidenceRefValue(link.from, `links[${index}].from`);
  if (typeof link.to !== "string" || !isRef(link.to)) {
    throw new EvidenceValidationError(`links[${index}].to must be a valid ref`);
  }
  if (!isEvidenceLinkRelation(link.relation)) {
    throw new EvidenceValidationError(`links[${index}].relation must be valid`);
  }
}

function validateEvidenceProvenance(provenance: unknown): void {
  if (!isRecord(provenance)) throw new EvidenceValidationError("provenance must be an object");
  if (!isEvidenceProducer(provenance.producer)) {
    throw new EvidenceValidationError("provenance.producer must be valid");
  }
  assertOptionalRefValue(provenance.runRef, "run", "provenance.runRef");
  assertOptionalRefValue(provenance.projectRef, "proj", "provenance.projectRef");
  assertOptionalRefValue(provenance.taskRef, "task", "provenance.taskRef");
  assertOptionalRefValue(provenance.roleRef, "role", "provenance.roleRef");
  assertOptionalNonEmptyString(provenance.note, "provenance.note");
  if (provenance.parentEvidenceRefs !== undefined) {
    if (!Array.isArray(provenance.parentEvidenceRefs)) {
      throw new EvidenceValidationError("provenance.parentEvidenceRefs must be an array");
    }
    provenance.parentEvidenceRefs.forEach((ref, index) =>
      assertEvidenceRefValue(ref, `provenance.parentEvidenceRefs[${index}]`),
    );
  }
}

function validateEvidenceCuration(curation: unknown): void {
  if (!isRecord(curation)) throw new EvidenceValidationError("curation must be an object");
  if (!isEvidenceCurationStatus(curation.status)) {
    throw new EvidenceValidationError("curation.status must be valid");
  }
  if (curation.retention !== undefined && !isEvidenceRetention(curation.retention)) {
    throw new EvidenceValidationError("curation.retention must be valid");
  }
  assertOptionalNonEmptyString(curation.reason, "curation.reason");
  assertOptionalEvidenceRefArray(curation.promotedFrom, "curation.promotedFrom");
  assertOptionalEvidenceRefArray(curation.supersededBy, "curation.supersededBy");
  if (curation.compactedInto !== undefined) {
    assertEvidenceRefValue(curation.compactedInto, "curation.compactedInto");
  }
  assertOptionalNonEmptyString(curation.expiresAt, "curation.expiresAt");
}

function validateEvidenceTranscriptRetention(retention: unknown): void {
  if (!isRecord(retention))
    throw new EvidenceValidationError("transcriptRetention must be an object");
  if (retention.schemaVersion !== 1) {
    throw new EvidenceValidationError("transcriptRetention.schemaVersion must be 1");
  }
  if (retention.strategy !== "role-run-compact-summary-tail") {
    throw new EvidenceValidationError(
      "transcriptRetention.strategy must be role-run-compact-summary-tail",
    );
  }
  assertNonEmpty(retention.candidateReason, "transcriptRetention.candidateReason");
  assertOptionalNonEmptyString(retention.originalBlobPath, "transcriptRetention.originalBlobPath");
  assertOptionalNonEmptyString(retention.originalHash, "transcriptRetention.originalHash");
  assertOptionalPositiveNumber(retention.originalBodySize, "transcriptRetention.originalBodySize");
  assertOptionalPositiveNumber(
    retention.originalMetadataBytes,
    "transcriptRetention.originalMetadataBytes",
  );
  assertNonEmpty(retention.replacementSummary, "transcriptRetention.replacementSummary");
  if (retention.transcriptTail !== undefined) validateTranscriptTail(retention.transcriptTail);
  assertOptionalNonEmptyString(retention.exportPath, "transcriptRetention.exportPath");
  assertNonEmpty(retention.compactedAt, "transcriptRetention.compactedAt");
  assertOptionalNonEmptyString(
    retention.fullTranscriptDeletedAt,
    "transcriptRetention.fullTranscriptDeletedAt",
  );
}

function validateTranscriptTail(tail: unknown): void {
  if (!isRecord(tail))
    throw new EvidenceValidationError("transcriptRetention.transcriptTail must be an object");
  assertPositiveNumber(tail.bytes, "transcriptRetention.transcriptTail.bytes");
  assertPositiveNumber(tail.tailBytes, "transcriptRetention.transcriptTail.tailBytes");
  if (typeof tail.truncated !== "boolean") {
    throw new EvidenceValidationError(
      "transcriptRetention.transcriptTail.truncated must be a boolean",
    );
  }
  if (tail.source !== "serialized-evidence-body-tail") {
    throw new EvidenceValidationError(
      "transcriptRetention.transcriptTail.source must be serialized-evidence-body-tail",
    );
  }
  assertString(tail.tail, "transcriptRetention.transcriptTail.tail");
}

function matchesQuery(evidence: EvidenceRecord, query: EvidenceQuery): boolean {
  if (query.kind && evidence.kind !== query.kind) return false;
  if (query.producer && evidence.provenance.producer !== query.producer) return false;
  if (query.projectRef && evidence.provenance.projectRef !== query.projectRef) return false;
  if (query.taskRef && evidence.provenance.taskRef !== query.taskRef) return false;
  if (query.roleRef && evidence.provenance.roleRef !== query.roleRef) return false;
  if (query.linkedTo && !evidence.links.some((link) => link.to === query.linkedTo)) return false;
  if (query.retention && evidence.curation?.retention !== query.retention) return false;
  if (query.curationStatus) {
    const statuses = Array.isArray(query.curationStatus)
      ? query.curationStatus
      : [query.curationStatus];
    if (!evidence.curation || !statuses.includes(evidence.curation.status)) return false;
  }
  if (query.includeRaw === false && evidence.curation?.status === "raw") return false;
  if (
    query.includeArchived === false &&
    (evidence.curation?.status === "archived" || evidence.curation?.status === "superseded")
  ) {
    return false;
  }
  return true;
}

function compactStoredEvidence(
  evidence: EvidenceRecord,
  serializedBody: string,
  options: { thresholdBytes: number; previewChars: number },
): EvidenceRecord {
  const compacted: EvidenceRecord = {
    ...evidence,
    body: previewBody(serializedBody, options.previewChars),
  };
  addBodyCompactionMetadata(compacted, serializedBody, options);
  return compacted;
}

function metadataBodyFor<T extends JsonValue | string>(
  body: T,
  serializedBody: string,
  options: { thresholdBytes: number; previewChars: number },
): T {
  if (Buffer.byteLength(serializedBody, "utf8") <= options.thresholdBytes) return body;
  return previewBody(serializedBody, options.previewChars) as T;
}

function addBodyCompactionMetadata(
  evidence: EvidenceRecord,
  serializedBody: string,
  options: { thresholdBytes: number; previewChars: number },
): void {
  const bodySize = Buffer.byteLength(serializedBody, "utf8");
  if (bodySize <= options.thresholdBytes) return;
  evidence.bodyPreview = previewBody(serializedBody, options.previewChars);
  evidence.bodySize = bodySize;
  evidence.bodyTruncated = true;
}

function previewBody(serializedBody: string, previewChars: number): string {
  return serializedBody.length > previewChars
    ? `${serializedBody.slice(0, previewChars)}\n… truncated ${serializedBody.length - previewChars} char(s)`
    : serializedBody;
}

function serializeEvidenceBody(format: EvidenceFormat, body: JsonValue | string): string {
  if (format === "json") {
    // JSON Evidence is content-addressed and must always contain valid JSON.
    // Accept legacy callers that passed pre-serialized JSON, while converting
    // ordinary strings into a valid JSON string instead of writing raw bytes.
    if (typeof body === "string") {
      try {
        return JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        return JSON.stringify(body, null, 2);
      }
    }
    return JSON.stringify(body, null, 2);
  }
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

function parseEvidenceBody(format: EvidenceFormat, body: string): JsonValue | string {
  if (format !== "json") return body;
  try {
    return JSON.parse(body) as JsonValue;
  } catch (error) {
    throw new EvidenceValidationError(
      `stored JSON Evidence body is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function extensionForFormat(format: EvidenceFormat): string {
  if (format === "markdown") return "md";
  if (format === "json") return "json";
  return "txt";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRef(value: string): boolean {
  const index = value.indexOf(":");
  return index > 0 && index < value.length - 1;
}

function assertRefValue(value: unknown, kind: string, label: string): void {
  if (typeof value !== "string" || !value.startsWith(`${kind}:`) || !isRef(value)) {
    throw new EvidenceValidationError(`${label} must be a valid ${kind} ref`);
  }
}

function assertOptionalRefValue(value: unknown, kind: string, label: string): void {
  if (value === undefined) return;
  assertRefValue(value, kind, label);
}

function assertOptionalEvidenceRefArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new EvidenceValidationError(`${label} must be an array`);
  value.forEach((entry, index) => assertEvidenceRefValue(entry, `${label}[${index}]`));
}

function assertString(value: unknown, label: string): void {
  if (typeof value !== "string") throw new EvidenceValidationError(`${label} must be a string`);
}

function assertNonEmpty(value: unknown, label: string): void {
  if (typeof value !== "string") throw new EvidenceValidationError(`${label} must be a string`);
  if (!value.trim()) throw new EvidenceValidationError(`${label} is required`);
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value === undefined) return;
  assertNonEmpty(value, label);
}

function assertPositiveNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new EvidenceValidationError(`${label} must be a positive number`);
  }
}

function assertOptionalPositiveNumber(value: unknown, label: string): void {
  if (value === undefined) return;
  assertPositiveNumber(value, label);
}

function assertOptionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new EvidenceValidationError(`${label} must be a boolean`);
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export {
  ARTIFACT_KINDS,
  ARTIFACT_FORMATS,
  ARTIFACT_PROJECTION_MAX_INLINE_BYTES,
  GIT_CHECKS_VERDICTS,
  ArtifactStore,
  ArtifactValidationError,
  applyWorktreeToPrBody,
  attachPrWorktree,
  defaultArtifactStore,
  isArtifactBody,
  isArtifactFormat,
  isArtifactKind,
  isLegacyArtifactBody,
  isStoredArtifactBody,
  isStoredArtifactKind,
  isWritableArtifactBody,
  issueBodyFromSnapshot,
  newArtifactRef,
  normalizeLegacyArtifactBody,
  parseForgeUrl,
  prBodyFromSnapshot,
  previewFormatAsArtifactFormat,
  projectArtifact,
  prWorktreePath,
  removePrWorktree,
  renderArtifactPreviewDocument,
  startTemporaryArtifactPreview,
  closeTemporaryArtifactPreviews,
  syncForgeIssue,
  syncForgePr,
  type AttachPrWorktreeInput,
  type AttachPrWorktreeResult,
  type CommandRunner,
  type ForgeHost,
  type ArtifactProgress,
  type DocumentArtifactBody,
  type WritableArtifactBody,
  type WritableDocumentArtifactBody,
  type GitChangeArtifactBody,
  type GitChangeEntry,
  type GitChangeLifecycle,
  type GitRevisionMaterializationAction,
  type GitRevisionMaterializationState,
  type GitChangeRepository,
  type GitChangeStack,
  type GitChangeWorktreeStatus,
  type GitChecksVerdict,
  type GitPullRequestCheck,
  type GitPullRequestSnapshot,
  type ForgeIssueSnapshot,
  type ForgePrSnapshot,
  type ForgeSyncOptions,
  type IssueArtifactBody,
  type LegacyArtifactBody,
  type LegacyIssueArtifactBody,
  type LegacyPrArtifactBody,
  type LegacyPreviewArtifactBody,
  type PrArtifactBody,
  type PreviewArtifactBody,
  type PreviewContentFormat,
  type PreviewProgress,
  type Artifact,
  type ArtifactBody,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactProjection,
  type ArtifactProjectionContentRef,
  type ArtifactProjectionFormat,
  type ArtifactQuery,
  type ArtifactPreviewDocumentInput,
  type ArtifactPreviewRenderResult,
  type ArtifactRef,
  type ArtifactStoreOptions,
  type PutArtifactInput,
  type PutManagedDocumentInput,
  type PutManagedDocumentResult,
  type StoredArtifactBody,
  type StoredArtifactKind,
  type TemporaryArtifactPreview,
  type WorktreeCommandRunner,
  type WorktreeStatus,
} from "./artifact/index.ts";

export {
  registerArtifactTool,
  registerSparkArtifactTools,
  type PiArtifactsExtensionApi,
} from "./artifact/extension.ts";

export {
  ARTIFACT_SYNC_FILE_MAX_BYTES,
  ARTIFACT_TRUSTED_SYNC_FILE_MAX_BYTES,
  readDocumentSyncFile,
  syncDocumentArtifactFile,
  type SyncDocumentArtifactFileInput,
  type SyncDocumentArtifactFileResult,
} from "./artifact/file-sync.ts";

export {
  GIT_SUBMIT_REQUIRED_CHECKS_TIMEOUT_MS,
  GitLifecycleError,
  GitLifecycleService,
  defaultGitCommandRunner,
  gitHubRepositoryFromRemote,
  type AdoptGitChangeInput,
  type CheckoutGitChangeInput,
  type CommitGitChangeInput,
  type CreateGitChangeInput,
  type GitCommandRunner,
  type GitLifecycleAction,
  type GitLifecycleServiceOptions,
} from "./git/lifecycle.ts";

export {
  registerGitLifecycleTool,
  registerSparkGitLifecycleTool,
  type GitLifecycleExtensionApi,
} from "./git/extension.ts";

export { requireCurrentLensPass } from "./git/verification-gate.ts";

export {
  GitRevisionMaterializationService,
  type ApplyCandidateRevisionInput,
  type CreateCandidateRevisionInput,
  type GitRevisionMaterializationInput,
  type GitRevisionMaterializationResult,
  type GitRevisionMaterializationServiceOptions,
} from "./git/revision-materialization.ts";
