import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonFileAtomic, writeTextFileAtomic } from "@zendev-lab/spark-core";
import {
  asJsonValue,
  isArtifactBody,
  isArtifactFormat,
  isArtifactKind,
  isStoredArtifactBody,
  isStoredArtifactKind,
  type Artifact,
  type ArtifactBody,
  type ArtifactFormat,
  type ArtifactQuery,
  type ArtifactRef,
  type ArtifactStoreOptions,
  type DocumentArtifactBody,
  type GitChangeArtifactBody,
  type IssueArtifactBody,
  type LegacyArtifactBody,
  type LegacyIssueArtifactBody,
  type LegacyPrArtifactBody,
  type LegacyPreviewArtifactBody,
  type PutArtifactInput,
  type StoredArtifactBody,
  type StoredArtifactKind,
} from "./types.ts";

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
}

export interface PutManagedDocumentInput {
  ref: ArtifactRef;
  bindingId: string;
  title: string;
  mediaType: DocumentArtifactBody["mediaType"];
  content: string;
  expectedRevision: number | null;
  progress?: DocumentArtifactBody["progress"];
  seal?: boolean;
}

export interface PutManagedDocumentResult {
  artifact: Artifact<DocumentArtifactBody>;
  created: boolean;
  changed: boolean;
}

interface StoredArtifact {
  ref: ArtifactRef;
  kind: StoredArtifactKind;
  title: string;
  format: ArtifactFormat;
  body: StoredArtifactBody;
  hash?: string;
  blobPath?: string;
  createdAt: string;
  updatedAt: string;
}

export class ArtifactStore {
  readonly rootDir: string;
  readonly blobDir: string;

  constructor(options: ArtifactStoreOptions) {
    this.rootDir = options.rootDir;
    this.blobDir = join(options.rootDir, "blobs");
  }

  async put<T extends ArtifactBody>(input: PutArtifactInput<T>): Promise<Artifact<T>> {
    await mkdir(this.rootDir, { recursive: true });
    await mkdir(this.blobDir, { recursive: true });
    if (!isArtifactKind(input.kind)) {
      throw new ArtifactValidationError(`invalid artifact kind: ${String(input.kind)}`);
    }
    if (input.body.kind !== input.kind) {
      throw new ArtifactValidationError(
        `body.kind (${input.body.kind}) must match artifact kind (${input.kind})`,
      );
    }
    if (!isArtifactBody(input.body)) {
      const candidate = input.body as unknown as Record<string, unknown>;
      if (candidate.kind === "document" && typeof candidate.mediaType === "string") {
        throw new ArtifactValidationError(
          `document media type is retired or unsupported for writes: ${candidate.mediaType}`,
        );
      }
      throw new ArtifactValidationError("invalid artifact body");
    }
    if (input.format !== undefined && !isArtifactFormat(input.format)) {
      throw new ArtifactValidationError(`invalid format: ${String(input.format)}`);
    }
    // A writable Document's media type is the canonical source of truth for
    // its top-level format. This matters when a retired Document is explicitly
    // converted: carrying the legacy format forward would also give the new
    // blob the wrong extension even though the body advertises a writable
    // media type.
    const format =
      input.body.kind === "document"
        ? defaultFormatForBody(input.body)
        : (input.format ?? defaultFormatForBody(input.body));
    const ref = input.ref ?? newArtifactRef();
    const existing = input.ref ? await this.tryGet(input.ref) : null;
    assertDocumentOverwriteAllowed(existing, input.body);
    const updatedAt = nextArtifactTimestamp(existing?.updatedAt);
    const serialized = serializeBody(input.body);
    const hash = createHash("sha256").update(serialized).digest("hex");
    const blobPath = join("blobs", `${hash}.${extensionForFormat(format)}`);
    const artifact: Artifact<T> = {
      ref,
      kind: input.kind,
      title: input.title.trim(),
      format,
      body: input.body,
      hash,
      blobPath,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };
    if (!artifact.title) throw new ArtifactValidationError("title is required");
    await writeTextFileAtomic(join(this.rootDir, blobPath), serialized);
    await writeJsonFileAtomic(this.pathFor(ref), {
      ...artifact,
      body: asJsonValue(input.body),
    });
    return artifact;
  }

  async update<T extends ArtifactBody>(
    ref: ArtifactRef,
    patch: Partial<Omit<PutArtifactInput<T>, "ref">>,
  ): Promise<Artifact<T>> {
    const existing = await this.get<T>(ref);
    return this.put<T>({
      ref,
      kind: patch.kind ?? existing.kind,
      title: patch.title ?? existing.title,
      format: patch.format ?? existing.format,
      body: patch.body ?? existing.body,
    });
  }

  /**
   * Daemon-owned Document update with an explicit expected revision. Identical
   * content keeps its revision; content/media changes advance it exactly once.
   * A sealed binding is immutable.
   */
  async putManagedDocument(input: PutManagedDocumentInput): Promise<PutManagedDocumentResult> {
    const existing = await this.tryGet<DocumentArtifactBody>(input.ref);
    if (existing && existing.kind !== "document") {
      throw new ArtifactValidationError(`managed Document ref is not a document: ${input.ref}`);
    }
    const current = existing?.body;
    if (current?.management?.authority === "daemon") {
      if (current.management.bindingId !== input.bindingId) {
        throw new ArtifactValidationError(`managed Document binding mismatch: ${input.ref}`);
      }
      if (current.management.lifecycle === "sealed") {
        throw new ArtifactValidationError(`managed Document is sealed: ${input.ref}`);
      }
    } else if (current) {
      throw new ArtifactValidationError(
        `Document is not owned by this daemon binding: ${input.ref}`,
      );
    }
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== input.expectedRevision) {
      throw new ArtifactValidationError(
        `DOCUMENT_REVISION_CONFLICT: ${input.ref} expected ${String(input.expectedRevision)} actual ${String(actualRevision)}`,
      );
    }
    const changed =
      !current || current.content !== input.content || current.mediaType !== input.mediaType;
    const revision = current ? current.revision + (changed ? 1 : 0) : 1;
    const artifact = await this.put<DocumentArtifactBody>({
      ref: input.ref,
      kind: "document",
      title: input.title,
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: input.mediaType,
        content: input.content,
        revision,
        ...(input.progress ? { progress: input.progress } : {}),
        management: {
          authority: "daemon",
          bindingId: input.bindingId,
          lifecycle: input.seal ? "sealed" : "live",
        },
      },
    });
    return { artifact, created: !existing, changed };
  }

  async get<T extends ArtifactBody = ArtifactBody>(ref: ArtifactRef): Promise<Artifact<T>> {
    assertArtifactRef(ref);
    const stored = normalizeStoredArtifactMetadata(await readJson(this.pathFor(ref)));
    if (stored.blobPath) {
      const blobPath = resolveBlobPath(this.rootDir, stored.blobPath);
      if (!blobPath) throw new ArtifactValidationError(`blob path escapes store: ${ref}`);
      stored.body = parseStoredBody(await readFile(blobPath, "utf8"));
    }
    assertStoredKindMatchesBody(stored.kind, stored.body);
    return normalizeStoredArtifact(stored) as Artifact<T>;
  }

  async tryGet<T extends ArtifactBody = ArtifactBody>(
    ref: ArtifactRef,
  ): Promise<Artifact<T> | null> {
    try {
      return await this.get<T>(ref);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(filter: ArtifactQuery = {}): Promise<Artifact[]> {
    await mkdir(this.rootDir, { recursive: true });
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const artifacts: Artifact[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const raw = await readJson(join(this.rootDir, entry.name));
        const stored = normalizeStoredArtifactMetadata(raw);
        const artifact = await this.get(stored.ref);
        if (filter.kind && artifact.kind !== filter.kind) continue;
        artifacts.push(artifact);
      } catch {
        // A malformed artifact does not make the remainder of the store unreadable.
      }
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pathFor(ref: ArtifactRef): string {
    assertArtifactRef(ref);
    return join(this.rootDir, `${refId(ref)}.json`);
  }
}

function assertDocumentOverwriteAllowed(existing: Artifact | null, nextBody: ArtifactBody): void {
  if (existing?.body.kind !== "document" || !existing.body.management) return;
  if (existing.body.management.lifecycle === "sealed") {
    throw new ArtifactValidationError(`managed Document is sealed: ${existing.ref}`);
  }
  if (
    nextBody.kind !== "document" ||
    nextBody.management?.authority !== "daemon" ||
    nextBody.management.bindingId !== existing.body.management.bindingId
  ) {
    throw new ArtifactValidationError(
      `managed Document requires its daemon binding: ${existing.ref}`,
    );
  }
}

export function newArtifactRef(id: string = randomUUID()): ArtifactRef {
  if (!id || id.includes(":")) {
    throw new ArtifactValidationError(`invalid artifact id: ${id}`);
  }
  return `artifact:${id}` as ArtifactRef;
}

export function defaultArtifactStore(cwd: string): ArtifactStore {
  return new ArtifactStore({ rootDir: join(cwd, ".spark", "artifacts") });
}

export function normalizeLegacyArtifactBody(body: LegacyArtifactBody): ArtifactBody {
  switch (body.kind) {
    case "issue":
      return normalizeLegacyIssue(body);
    case "pr":
      return normalizeLegacyPr(body);
    case "preview":
      return normalizeLegacyPreview(body);
  }
}

function normalizeLegacyIssue(body: LegacyIssueArtifactBody): IssueArtifactBody {
  return { ...body, schemaVersion: 2 };
}

function normalizeLegacyPr(body: LegacyPrArtifactBody): GitChangeArtifactBody {
  const state = body.state.toLowerCase();
  const terminal = state === "merged" || state === "closed";
  const removed = body.worktreeStatus === "removed";
  return {
    schemaVersion: 2,
    kind: "git_change",
    repository: {
      forge: body.forge,
      repo: body.repo,
    },
    trunk: body.baseRef,
    worktree: {
      path: body.worktreePath,
      branch: body.worktreeBranch ?? body.headRef,
      ownership: "external",
      status: removed
        ? "cleaned"
        : body.worktreePath && body.worktreeStatus === "attached"
          ? "attached"
          : "missing",
    },
    stack: {
      authority: "legacy-unbound",
      currentBranch: body.headRef,
      entries: [
        {
          branch: body.headRef,
          base: body.baseRef,
          isCurrent: true,
          isMerged: state === "merged",
          isQueued: false,
          needsRebase: false,
          pullRequest: {
            forge: body.forge,
            repo: body.repo,
            number: body.number,
            url: body.url,
            state: body.state,
            title: body.title,
            labels: body.labels,
            syncedAt: body.syncedAt,
            bodyText: body.bodyText,
            headRef: body.headRef,
            baseRef: body.baseRef,
            draft: body.draft,
            checksSummary: body.checksSummary,
            diffSummary: body.diffSummary,
          },
        },
      ],
      observedAt: body.syncedAt,
    },
    lifecycle: removed ? "cleaned" : terminal ? "terminal" : "published",
  };
}

function normalizeLegacyPreview(body: LegacyPreviewArtifactBody): DocumentArtifactBody {
  return {
    schemaVersion: 2,
    kind: "document",
    mediaType: legacyPreviewMediaType(body.format),
    content: body.content,
    revision: body.version,
    progress: body.progress,
  };
}

function legacyPreviewMediaType(
  format: LegacyPreviewArtifactBody["format"],
): DocumentArtifactBody["mediaType"] {
  switch (format) {
    case "md":
      return "text/markdown";
    case "mdx":
      return "text/mdx";
    case "html":
      return "text/html";
    case "a2ui":
      return "application/vnd.a2ui+json";
  }
}

function normalizeStoredArtifact(stored: StoredArtifact): Artifact {
  const body = isArtifactBody(stored.body) ? stored.body : normalizeLegacyArtifactBody(stored.body);
  return {
    ref: stored.ref,
    kind: body.kind,
    title: stored.title,
    format: stored.format,
    body,
    hash: stored.hash,
    blobPath: stored.blobPath,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}

function normalizeStoredArtifactMetadata(raw: unknown): StoredArtifact {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactValidationError("artifact metadata must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.ref !== "string") {
    throw new ArtifactValidationError("artifact ref must be artifact:…");
  }
  assertArtifactRef(record.ref);
  if (!isStoredArtifactKind(record.kind)) {
    throw new ArtifactValidationError(
      "kind must be issue, git_change, document, or a supported legacy kind",
    );
  }
  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new ArtifactValidationError("title is required");
  }
  if (!isArtifactFormat(record.format)) {
    throw new ArtifactValidationError("invalid format");
  }
  if (!isStoredArtifactBody(record.body)) {
    throw new ArtifactValidationError("invalid body");
  }
  assertStoredKindMatchesBody(record.kind, record.body);
  return {
    ref: record.ref,
    kind: record.kind,
    title: record.title,
    format: record.format,
    body: record.body,
    hash: typeof record.hash === "string" ? record.hash : undefined,
    blobPath: typeof record.blobPath === "string" ? record.blobPath : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
}

function assertStoredKindMatchesBody(kind: StoredArtifactKind, body: StoredArtifactBody): void {
  if (body.kind !== kind) {
    throw new ArtifactValidationError("body.kind must match kind");
  }
}

function assertArtifactRef(ref: string): asserts ref is ArtifactRef {
  if (!ref.startsWith("artifact:") || ref.length === "artifact:".length) {
    throw new ArtifactValidationError("artifact ref must be artifact:…");
  }
}

function nextArtifactTimestamp(previous?: string): string {
  const currentTime = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(
    Number.isNaN(previousTime) ? currentTime : Math.max(currentTime, previousTime + 1),
  ).toISOString();
}

function defaultFormatForBody(body: ArtifactBody): ArtifactFormat {
  if (body.kind !== "document") return "json";
  switch (body.mediaType) {
    case "text/markdown":
      return "markdown";
    case "text/mdx":
      return "mdx";
    case "text/html":
      return "html";
    default:
      return "json";
  }
}

function extensionForFormat(format: ArtifactFormat): string {
  switch (format) {
    case "markdown":
    case "mdx":
      return "md";
    case "html":
      return "html";
    case "json":
      return "json";
    case "text":
      return "txt";
  }
}

function serializeBody(body: ArtifactBody): string {
  return JSON.stringify(body, null, 2);
}

function parseStoredBody(serialized: string): StoredArtifactBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new ArtifactValidationError("blob is not valid JSON");
  }
  if (!isStoredArtifactBody(parsed)) {
    throw new ArtifactValidationError("blob is not a valid artifact body");
  }
  return parsed;
}

function refId(ref: string): string {
  const index = ref.indexOf(":");
  if (index < 0) throw new ArtifactValidationError(`invalid ref: ${ref}`);
  return ref.slice(index + 1);
}

function resolveBlobPath(rootDir: string, blobPath: string): string | undefined {
  if (!blobPath.trim() || blobPath.includes("\0") || isAbsolute(blobPath)) return undefined;
  const root = resolve(rootDir);
  const blobRoot = resolve(root, "blobs");
  const resolved = resolve(root, blobPath);
  const scoped = relative(blobRoot, resolved);
  if (!scoped || scoped.startsWith("..") || isAbsolute(scoped)) return undefined;
  return resolved;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ArtifactValidationError(`invalid artifact JSON: ${path}`);
  }
}
