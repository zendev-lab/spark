/** DSH handles over the Session owner's canonical Spark transcript files. */
import { mkdir, open, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import SessionPersistence, {
  assertContiguous,
  assertVersion,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionReadOnlyError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadResult,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceStatOptions,
  type SessionPersistenceSnapshot,
} from "@deepseek-ai/dsh-session-persistence";
import {
  SessionId,
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import { SparkJsonlSessionFiles } from "@zendev-lab/spark-session/transcript";

export class SparkDaemonSessionPersistence extends SessionPersistence {
  static inject = ["sessions"];
  private readonly writers = new Map<SessionId, SparkSessionHandle>();
  private readonly handles = new Set<SparkSessionHandle>();

  private readonly files: SparkJsonlSessionFiles;

  constructor(ctx: Context, files: SparkJsonlSessionFiles) {
    super(ctx);
    this.files = files;
    ctx.on("session/event", (session: Session, event) => {
      void this.writers
        .get(session.id)
        ?.route(event)
        .catch((error: unknown) => ctx.logger.warn(String(error)));
    });
    ctx.on("session/flush", (session: Session) => this.writers.get(session.id)?.flush());
    ctx.on("session/disposed", (session: Session) => {
      void this.writers
        .get(session.id)
        ?.close()
        .catch((error: unknown) => ctx.logger.warn(String(error)));
    });
    ctx.effect(() => async () => {
      const results = await Promise.allSettled([...this.handles].map((handle) => handle.close()));
      throwFailures(results, "Spark session persistence dispose failed");
    });
  }

  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const meta = materializeCreateHeader(header);
    assertVersion(meta);
    const inherited = SessionLogOffset(options?.inheritedEventCount ?? 0);
    if (meta.isSeeded ? options?.inheritedEventCount === undefined : inherited !== 0) {
      throw new Error("Session inherited event count does not match its seeded header");
    }
    const lease = await this.acquire(meta.id);
    try {
      if (
        this.writers.has(meta.id) ||
        (await this.files.readStoredRevision(meta.id, options?.signal))
      ) {
        throw new SessionAlreadyExistsError(meta.id);
      }
      return this.register(
        new SparkSessionHandle(this.files, meta, inherited, "write", false, lease, (handle) =>
          this.release(handle),
        ),
      );
    } catch (error) {
      await lease.close();
      throw error;
    }
  }

  async open(
    id: SessionId,
    access: SessionAccess,
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted();
    const lease = access === "write" ? await this.acquire(id) : undefined;
    try {
      const pending = this.writers.get(id);
      const stored = await this.files.loadStored(id, options?.signal);
      if (!stored && !pending) throw new SessionPersistenceNotFoundError(id);
      const { inheritedEventCount = 0, ...header } = stored?.meta ?? pending!.storageHeader;
      assertVersion(header, stored ? { kind: "jsonl", path: stored.path } : undefined);
      const handle = new SparkSessionHandle(
        this.files,
        header as SessionHeader,
        SessionLogOffset(inheritedEventCount),
        access,
        !!stored,
        lease,
        (handle) => this.release(handle),
        pending,
      );
      if (stored) handle.initialize(stored.events as SessionEvent[], stored.tornMarker);
      return this.register(handle);
    } catch (error) {
      await lease?.close();
      throw error;
    }
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.writers.values()].map(async (handle) =>
        handle.closed ? handle.close() : handle.flush(),
      ),
    );
    throwFailures(results, "Spark session persistence flush failed");
  }

  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted();
    const writer = this.writers.get(id);
    if (writer) return writer.snapshot();
    const header = (await this.files.list(options?.signal)).find(
      (candidate) => candidate.id === id,
    );
    if (!header) return undefined;
    const revision = await this.files.readStoredRevision(id, options?.signal);
    if (!revision) return undefined;
    const { inheritedEventCount: _inherited, ...meta } = header;
    return { header: meta as SessionHeader, revision: SessionPersistenceRevision(revision) };
  }

  async list(
    options?: SessionPersistenceListOptions,
  ): Promise<readonly SessionPersistenceSnapshot[]> {
    const ids = new Set((await this.files.list(options?.signal)).map((header) => header.id));
    for (const id of this.writers.keys()) ids.add(id);
    const snapshots: SessionPersistenceSnapshot[] = [];
    for (const id of ids) {
      const snapshot = await this.stat(id, options);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  private register(handle: SparkSessionHandle): SparkSessionHandle {
    this.handles.add(handle);
    if (handle.access === "write") this.writers.set(handle.id, handle);
    return handle;
  }

  private release(handle: SparkSessionHandle): void {
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id);
    this.handles.delete(handle);
  }

  private async acquire(id: SessionId): Promise<FileHandle> {
    if (this.writers.has(id)) throw new SessionAlreadyOwnedError(id);
    const dir = join(this.files.sessionsRoot, ".write-locks");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${encodeURIComponent(id)}.lock`);
    const handle = await open(path, "a", 0o600);
    try {
      await tryLockExclusive(handle.fd);
      const held = await handle.stat({ bigint: true });
      const current = await stat(path, { bigint: true });
      if (held.ino !== current.ino || held.dev !== current.dev)
        throw new SessionAlreadyOwnedError(id);
      return handle;
    } catch (error) {
      await handle.close();
      if (["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw new SessionAlreadyOwnedError(id);
      throw error;
    }
  }
}

class SparkSessionHandle implements SessionHandle {
  readonly id: SessionId;
  private events: readonly SessionEvent[] = [];
  private pending: SessionEvent[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private tornMarker?: number;
  closed = false;

  private readonly files: SparkJsonlSessionFiles;
  readonly header: SessionHeader;
  readonly inheritedEventCount: SessionLogOffset;
  readonly access: SessionAccess;
  private materialized: boolean;
  private readonly lease: FileHandle | undefined;
  private readonly release: (handle: SparkSessionHandle) => void;
  private readonly pendingWriter: SparkSessionHandle | undefined;

  constructor(
    files: SparkJsonlSessionFiles,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    access: SessionAccess,
    materialized: boolean,
    lease: FileHandle | undefined,
    release: (handle: SparkSessionHandle) => void,
    pendingWriter?: SparkSessionHandle,
  ) {
    this.id = header.id;
    this.files = files;
    this.header = header;
    this.inheritedEventCount = inheritedEventCount;
    this.access = access;
    this.materialized = materialized;
    this.lease = lease;
    this.release = release;
    this.pendingWriter = pendingWriter;
  }

  get storageHeader() {
    return { ...this.header, inheritedEventCount: this.inheritedEventCount };
  }

  initialize(events: SessionEvent[], tornMarker?: number): void {
    assertContiguous(this.id, events, 0);
    this.events = validateStoredEvents(this.header, events);
    if (this.inheritedEventCount > this.events.length)
      throw new Error("Session inherited prefix exceeds its event log");
    this.tornMarker = tornMarker;
  }

  snapshot(): SessionPersistenceSnapshot {
    return {
      header: this.header,
      revision: SessionPersistenceRevision(`live:${this.header.createdAt}:${this.events.length}`),
      eventCount: this.events.length,
    };
  }

  route(event: SessionEvent): Promise<void> {
    this.pending.push(...materializeAppendBatch([event]));
    return this.closing ?? this.enqueue(() => this.drain());
  }

  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: { signal?: AbortSignal },
  ): Promise<SessionHandleReadResult> {
    this.assertOpen("read");
    options?.signal?.throwIfAborted();
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
      throw new TypeError("Session read offset and length must be non-negative safe integers");
    await this.chain;
    if (this.access === "read") {
      const stored = await this.files.loadStored(this.id, options?.signal);
      if (stored && stored.events.length >= this.events.length)
        this.initialize(stored.events as SessionEvent[]);
      else if (!stored && this.pendingWriter)
        return this.pendingWriter.read(offset, length, options);
    }
    return {
      eventState: "detached",
      events: structuredClone(this.events.slice(offset, offset + length)),
    };
  }

  async append(events: readonly SessionEvent[], options?: { signal?: AbortSignal }): Promise<void> {
    this.assertWrite("append");
    const batch = materializeAppendBatch(events);
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      await this.drain();
      await this.persist(batch);
    });
  }

  async flush(options?: { signal?: AbortSignal }): Promise<void> {
    this.assertWrite("flush");
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      await this.drain();
      await this.files.materializeHeader(this.storageHeader);
      this.materialized = true;
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.enqueue(async () => {
      try {
        if (this.access === "write") {
          while (this.pending.length > 0) await this.drain();
        }
      } finally {
        this.release(this);
        await this.lease?.close();
      }
    });
    return this.closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending.slice();
    await this.persist(batch);
    this.pending.splice(0, batch.length);
  }

  private async persist(batch: readonly SessionEvent[]): Promise<void> {
    if (batch.length === 0) return;
    assertContiguous(this.id, batch, this.events.length);
    const stored = batch.map((event) =>
      event.type.startsWith("spark/") ? { ...event, ignorable: true as const } : event,
    );
    validateStoredEvents(this.header, stored);
    if (this.tornMarker !== undefined) {
      await this.files.commitRepair(this.storageHeader, this.tornMarker, []);
      this.tornMarker = undefined;
    }
    await this.files.appendBatch(this.storageHeader, stored, this.materialized);
    this.events = [...this.events, ...stored];
    this.materialized = true;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation, operation);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation);
  }

  private assertWrite(operation: string): void {
    this.assertOpen(operation);
    if (this.access !== "write") throw new SessionReadOnlyError(this.id, operation);
  }
}

function throwFailures(results: PromiseSettledResult<unknown>[], message: string): void {
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, message);
}

export function createSparkDaemonSessionPersistencePlugin(sessionsRoot: string) {
  const files = new SparkJsonlSessionFiles(sessionsRoot);
  return class SparkDaemonSessionPersistencePlugin extends SparkDaemonSessionPersistence {
    static inject = ["sessions"];
    constructor(ctx: Context) {
      super(ctx, files);
    }
  };
}

export async function mountSparkDaemonSessionPersistence(
  ctx: Context,
  sessionsRoot: string,
): Promise<void> {
  await ctx.plugin(createSparkDaemonSessionPersistencePlugin(sessionsRoot));
}
