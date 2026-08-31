/** Session-owned filesystem primitives behind Spark's DSH JSONL PersistenceBackend. */

import { createHash } from "node:crypto";
import { open, readdir, readFile, stat, truncate } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  isDshSessionHeader,
  isPiSessionHeader,
  parseJsonlObjects,
  sparkHeaderFromDshLine,
  type SparkDshSessionEvent,
  type SparkDshSessionHeader,
} from "./dsh-format.ts";
import { writeJsonLinesAtomically } from "./jsonl-io.ts";
import { CURRENT_SPARK_SESSION_VERSION, type SparkSessionHeader } from "./types.ts";

export interface SparkJsonlStoredPrefix {
  meta: SparkDshSessionHeader;
  events: SparkDshSessionEvent[];
  revision: string;
  path: string;
  tornMarker?: number;
}

export interface SparkJsonlSessionLocation {
  kind: "jsonl";
  path: string;
}

export class SparkJsonlSessionFiles {
  readonly name = "spark-jsonl";
  readonly sessionsRoot: string;
  private readonly paths = new Map<string, string>();

  constructor(sessionsRoot: string) {
    this.sessionsRoot = sessionsRoot;
  }

  locate(meta: SparkDshSessionHeader): SparkJsonlSessionLocation {
    return { kind: "jsonl", path: this.canonicalPath(meta) };
  }

  canonicalPath(meta: Pick<SparkDshSessionHeader, "id" | "cwd">): string {
    const cwd = meta.cwd;
    if (!cwd)
      throw new Error(`Spark JSONL persistence requires an absolute cwd for session ${meta.id}`);
    return join(
      this.sessionsRoot,
      workspaceSessionHash(cwd),
      `${encodeURIComponent(meta.id)}.jsonl`,
    );
  }

  async loadStored(id: string, signal?: AbortSignal): Promise<SparkJsonlStoredPrefix | undefined> {
    signal?.throwIfAborted();
    const path = await this.findPath(id);
    if (!path) return undefined;
    const content = await readFile(path, "utf8");
    const parsed = parseJsonlObjects(content);
    const header = parsed.objects[0];
    if (!isDshSessionHeader(header) || header.id !== id) return undefined;
    const events: SparkDshSessionEvent[] = [];
    for (const value of parsed.objects.slice(1)) {
      if (!isRecord(value) || typeof value.type !== "string" || typeof value.seq !== "number") {
        continue;
      }
      events.push({
        type: value.type,
        seq: value.seq,
        time: typeof value.time === "number" ? value.time : 0,
        data: value.data,
        ...(value.ignorable === true ? { ignorable: true as const } : {}),
        ...(Array.isArray(value.sourceEventSeqs)
          ? { sourceEventSeqs: value.sourceEventSeqs as number[] }
          : {}),
        ...(value.surfaceOp === "append" || isSurfaceReplacement(value.surfaceOp)
          ? { surfaceOp: value.surfaceOp }
          : {}),
      });
    }
    const sparkMeta = events.find((event) => event.type === "spark/meta");
    if (
      events.length > 0 &&
      (!sparkMeta ||
        !isRecord(sparkMeta.data) ||
        sparkMeta.data.sparkVersion !== CURRENT_SPARK_SESSION_VERSION)
    ) {
      throw new Error(`Spark JSONL persistence refuses pre-v4 transcript: ${path}`);
    }
    this.paths.set(id, path);
    const revision = await this.revisionFor(path);
    return {
      meta: header,
      events,
      revision,
      path,
      ...(parsed.tornOffset !== undefined ? { tornMarker: parsed.tornOffset } : {}),
    };
  }

  async readStoredRevision(id: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const path = this.paths.get(id) ?? (await this.findPath(id));
    if (!path) return undefined;
    return await this.revisionFor(path);
  }

  async appendBatch(
    meta: SparkDshSessionHeader,
    events: readonly SparkDshSessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    const path = isMaterialized
      ? (this.paths.get(meta.id) ?? (await this.findPath(meta.id)) ?? this.canonicalPath(meta))
      : this.canonicalPath(meta);
    if (!isMaterialized) {
      await writeJsonLinesAtomically(path, [meta, ...events.map(persistedSparkEvent)]);
      this.paths.set(meta.id, path);
      return;
    }
    if (events.length === 0) return;
    const handle = await open(path, "a");
    try {
      await handle.write(
        `${events.map((event) => JSON.stringify(persistedSparkEvent(event))).join("\n")}\n`,
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.paths.set(meta.id, path);
  }

  async materializeHeader(meta: SparkDshSessionHeader): Promise<void> {
    const existing = this.paths.get(meta.id) ?? (await this.findPath(meta.id));
    if (existing) {
      this.paths.set(meta.id, existing);
      return;
    }
    const path = this.canonicalPath(meta);
    await writeJsonLinesAtomically(path, [meta]);
    this.paths.set(meta.id, path);
  }

  async commitRepair(
    meta: SparkDshSessionHeader,
    tornMarker: number | undefined,
    closers: readonly SparkDshSessionEvent[],
  ): Promise<void> {
    const path =
      this.paths.get(meta.id) ?? (await this.findPath(meta.id)) ?? this.canonicalPath(meta);
    if (tornMarker !== undefined) {
      await truncate(path, tornMarker);
    }
    if (closers.length > 0) {
      await this.appendBatch(meta, closers, true);
    }
    this.paths.set(meta.id, path);
  }

  async list(signal?: AbortSignal): Promise<SparkDshSessionHeader[]> {
    signal?.throwIfAborted();
    const headers: SparkDshSessionHeader[] = [];
    for (const path of await this.listJsonlPaths()) {
      signal?.throwIfAborted();
      const header = await readDshHeader(path);
      if (header) headers.push(header);
    }
    return headers;
  }

  async readRaw(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ filename: string; content: string; meta: SparkDshSessionHeader } | undefined> {
    signal?.throwIfAborted();
    const stored = await this.loadStored(id, signal);
    if (!stored) return undefined;
    return {
      filename: stored.path.split("/").at(-1) ?? `${id}.jsonl`,
      content: await readFile(stored.path, "utf8"),
      meta: stored.meta,
    };
  }

  private async findPath(id: string): Promise<string | undefined> {
    const cached = this.paths.get(id);
    if (cached) return cached;
    const matches: string[] = [];
    for (const path of await this.listJsonlPaths()) {
      const header = await readAnyHeader(path);
      if (header?.id === id) matches.push(path);
    }
    const canonicalSuffix = `/${encodeURIComponent(id)}.jsonl`;
    return matches.find((path) => path.endsWith(canonicalSuffix)) ?? matches.sort().at(-1);
  }

  private async listJsonlPaths(): Promise<string[]> {
    let workspaceDirs: string[];
    try {
      workspaceDirs = await readdir(this.sessionsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const paths: string[] = [];
    for (const name of workspaceDirs) {
      const dir = join(this.sessionsRoot, name);
      let files: string[];
      try {
        const stats = await stat(dir);
        if (!stats.isDirectory()) continue;
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (file.endsWith(".jsonl")) paths.push(join(dir, file));
      }
    }
    return paths;
  }

  private async revisionFor(path: string): Promise<string> {
    const stats = await stat(path);
    return `${path}:${stats.size}:${stats.mtimeMs}`;
  }
}

function persistedSparkEvent(event: SparkDshSessionEvent): SparkDshSessionEvent {
  return event.type.startsWith("spark/") ? { ...event, ignorable: true } : event;
}

export async function readDshOrPiSessionHeader(
  path: string,
): Promise<SparkSessionHeader | undefined> {
  const first = await readFirstJsonLine(path);
  if (isPiSessionHeader(first)) return first;
  if (!isDshSessionHeader(first)) return undefined;
  const second = await readNthJsonLine(path, 1);
  const meta =
    isRecord(second) && second.type === "spark/meta" && isRecord(second.data)
      ? (second.data as {
          timestamp?: string;
          sparkVersion?: number;
          visibility?: SparkSessionHeader["visibility"];
          purpose?: SparkSessionHeader["purpose"];
          parentSessionPath?: string;
        })
      : undefined;
  return sparkHeaderFromDshLine(
    first,
    meta && typeof meta.timestamp === "string"
      ? {
          timestamp: meta.timestamp,
          sparkVersion: typeof meta.sparkVersion === "number" ? meta.sparkVersion : 3,
          ...(meta.visibility ? { visibility: meta.visibility } : {}),
          ...(meta.purpose ? { purpose: meta.purpose } : {}),
          ...(typeof meta.parentSessionPath === "string"
            ? { parentSessionPath: meta.parentSessionPath }
            : {}),
        }
      : undefined,
  );
}

async function readDshHeader(path: string): Promise<SparkDshSessionHeader | undefined> {
  const first = await readFirstJsonLine(path);
  return isDshSessionHeader(first) ? first : undefined;
}

async function readAnyHeader(path: string): Promise<{ id: string } | undefined> {
  const first = await readFirstJsonLine(path);
  if (isPiSessionHeader(first) || isDshSessionHeader(first)) return { id: first.id };
  return undefined;
}

async function readFirstJsonLine(path: string): Promise<unknown> {
  return await readNthJsonLine(path, 0);
}

async function readNthJsonLine(path: string, index: number): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    const line = lines[index]?.trim();
    if (!line) return undefined;
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSurfaceReplacement(
  value: unknown,
): value is { op: "replace"; start: number; end: number } {
  return (
    isRecord(value) &&
    value.op === "replace" &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  );
}

function workspaceSessionHash(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}
