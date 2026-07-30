import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { writeJsonFileAtomic, writeTextFileAtomic } from "@zendev-lab/spark-core";
import {
  asJsonValue,
  isArtifactBody,
  isArtifactFormat,
  isArtifactKind,
  type Artifact,
  type ArtifactBody,
  type ArtifactFormat,
  type ArtifactKind,
  type ArtifactQuery,
  type ArtifactRef,
  type ArtifactStoreOptions,
  type PutArtifactInput,
} from "./types.ts";

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactValidationError";
  }
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
      throw new ArtifactValidationError("invalid artifact body");
    }
    const format = input.format ?? defaultFormatForKind(input.kind);
    if (!isArtifactFormat(format)) {
      throw new ArtifactValidationError(`invalid format: ${String(format)}`);
    }
    const ref = input.ref ?? newArtifactRef();
    const existing = input.ref ? await this.tryGet<T>(input.ref) : null;
    const updatedAt = nextArtifactTimestamp(existing?.updatedAt);
    const serialized = serializeBody(format, input.body);
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

  async get<T extends ArtifactBody = ArtifactBody>(ref: ArtifactRef): Promise<Artifact<T>> {
    assertArtifactRef(ref);
    const raw = await readJson(this.pathFor(ref));
    const artifact = normalizeArtifact<T>(raw);
    if (artifact.blobPath) {
      const blobPath = resolveBlobPath(this.rootDir, artifact.blobPath);
      if (!blobPath) {
        throw new ArtifactValidationError(`blob path escapes store: ${ref}`);
      }
      const serialized = await readFile(blobPath, "utf8");
      artifact.body = parseBody(artifact.format, serialized) as T;
    }
    return artifact;
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
      let artifact: Artifact;
      try {
        artifact = normalizeArtifact(await readJson(join(this.rootDir, entry.name)));
      } catch {
        continue;
      }
      if (!isArtifactKind(artifact.kind)) continue;
      if (filter.kind && artifact.kind !== filter.kind) continue;
      artifacts.push(artifact);
    }
    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  pathFor(ref: ArtifactRef): string {
    assertArtifactRef(ref);
    return join(this.rootDir, `${refId(ref)}.json`);
  }
}

function assertArtifactRef(ref: string): asserts ref is ArtifactRef {
  if (!ref.startsWith("artifact:") || ref.length === "artifact:".length) {
    throw new ArtifactValidationError("artifact ref must be artifact:…");
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

function nextArtifactTimestamp(previous?: string): string {
  const currentTime = Date.now();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return new Date(
    Number.isNaN(previousTime) ? currentTime : Math.max(currentTime, previousTime + 1),
  ).toISOString();
}

function defaultFormatForKind(kind: ArtifactKind): ArtifactFormat {
  switch (kind) {
    case "preview":
      return "mdx";
    case "issue":
    case "pr":
      return "json";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
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
    default: {
      const _exhaustive: never = format;
      return _exhaustive;
    }
  }
}

function serializeBody(_format: ArtifactFormat, body: ArtifactBody): string {
  return JSON.stringify(body, null, 2);
}

function parseBody(_format: ArtifactFormat, serialized: string): ArtifactBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    throw new ArtifactValidationError("blob is not valid JSON");
  }
  if (!isArtifactBody(parsed)) {
    throw new ArtifactValidationError("blob is not a valid artifact body");
  }
  return parsed;
}

function normalizeArtifact<T extends ArtifactBody>(raw: unknown): Artifact<T> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArtifactValidationError("artifact metadata must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.ref !== "string" || !record.ref.startsWith("artifact:")) {
    throw new ArtifactValidationError("artifact ref must be artifact:…");
  }
  if (!isArtifactKind(record.kind)) {
    throw new ArtifactValidationError("kind must be issue, pr, or preview");
  }
  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new ArtifactValidationError("title is required");
  }
  if (!isArtifactFormat(record.format)) {
    throw new ArtifactValidationError("invalid format");
  }
  if (!isArtifactBody(record.body)) {
    throw new ArtifactValidationError("invalid body");
  }
  if (record.body.kind !== record.kind) {
    throw new ArtifactValidationError("body.kind must match kind");
  }
  return {
    ref: record.ref as ArtifactRef,
    kind: record.kind,
    title: record.title,
    format: record.format,
    body: record.body as T,
    hash: typeof record.hash === "string" ? record.hash : undefined,
    blobPath: typeof record.blobPath === "string" ? record.blobPath : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
  };
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
