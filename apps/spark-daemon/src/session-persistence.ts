/**
 * Cordis SessionPersistence that stores DSH session JSONL through Spark host files.
 *
 * Disk layout and coordinator belong to dsh-session-persistence. Spark only
 * implements PersistenceBackend path selection under the Spark sessions root.
 */
import SessionPersistence, {
  PersistenceCoordinator,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionInspection,
  type SessionLocation,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from "@deepseek-ai/dsh-session-persistence";
import { SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import type { Context } from "@deepseek-ai/cordis";
import { SparkJsonlSessionFiles } from "@zendev-lab/spark-host/session-store";

export class SparkDaemonSessionPersistence
  extends SessionPersistence
  implements PersistenceBackend<number>
{
  static inject = ["sessions"];
  readonly name = "spark-jsonl";
  readonly supportsRawArtifacts = true;
  private readonly coordinator: PersistenceCoordinator<number>;
  private readonly files: SparkJsonlSessionFiles;

  constructor(ctx: Context, files: SparkJsonlSessionFiles) {
    super(ctx);
    this.files = files;
    this.coordinator = new PersistenceCoordinator(ctx, this);
  }

  locate(meta: SessionHeader): SessionLocation | undefined {
    return this.files.locate(meta);
  }

  async create(meta: SessionHeader): Promise<void> {
    await this.coordinator.create(meta);
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    await this.coordinator.append(id, events);
  }

  async load(id: SessionId): Promise<SessionInspection> {
    return await this.coordinator.load(id);
  }

  async inspect(id: SessionId, signal?: AbortSignal): Promise<SessionInspection> {
    return await this.coordinator.inspect(id, signal);
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return await this.coordinator.readFrom(id, fromSeq, signal);
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    return (await this.files.list(signal)) as SessionHeader[];
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    const headers = await this.list(signal);
    const snapshots: SessionPersistenceSnapshot[] = [];
    for (const header of headers) {
      signal?.throwIfAborted();
      const revision = await this.readStoredRevision(header.id, signal);
      if (!revision) continue;
      snapshots.push({ header, revision });
    }
    return snapshots;
  }

  async readRaw(id: SessionId, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const raw = await this.files.readRaw(id, signal);
    if (!raw) return undefined;
    return {
      meta: raw.meta as SessionHeader,
      filename: raw.filename,
      content: raw.content,
    };
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<number> | undefined> {
    const stored = await this.files.loadStored(id, signal);
    if (!stored) return undefined;
    return {
      meta: stored.meta as SessionHeader,
      events: stored.events as SessionEvent[],
      revision: SessionPersistenceRevision(stored.revision),
      ...(stored.tornMarker !== undefined ? { tornMarker: stored.tornMarker } : {}),
    };
  }

  async readStoredRevision(
    id: SessionId,
    signal?: AbortSignal,
  ): Promise<SessionPersistenceRevision | undefined> {
    const revision = await this.files.readStoredRevision(id, signal);
    return revision === undefined ? undefined : SessionPersistenceRevision(revision);
  }

  async appendBatch(
    meta: SessionHeader,
    events: readonly SessionEvent[],
    isMaterialized: boolean,
  ): Promise<void> {
    await this.files.appendBatch(meta, events, isMaterialized);
  }

  async commitRepair(
    meta: SessionHeader,
    tornMarker: number | undefined,
    closers: readonly SessionEvent[],
  ): Promise<void> {
    await this.files.commitRepair(meta, tornMarker, closers);
  }
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
