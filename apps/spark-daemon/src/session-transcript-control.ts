import { resolve } from "node:path";
import { SparkSessionStore } from "@zendev-lab/spark-host/session-store";
import type { SparkSessionState } from "@zendev-lab/spark-protocol";
import type { DaemonSessionRegistry } from "./session-registry.ts";

export interface EnsureDaemonSessionTranscriptInput {
  session: SparkSessionState;
  sparkHome: string;
  registry: Pick<DaemonSessionRegistry, "bindTranscriptPath">;
  expectedIncarnation?: number;
  expectedLifecycle?: "open";
}

export type ResolveDaemonSessionTranscriptInput = Omit<
  EnsureDaemonSessionTranscriptInput,
  "registry" | "expectedIncarnation" | "expectedLifecycle"
>;

/**
 * Resolve an already persisted transcript without allocating or binding one.
 * This keeps `/compact` on a blank provisional Session a true no-op.
 */
export async function resolveDaemonSessionTranscript(
  input: ResolveDaemonSessionTranscriptInput,
): Promise<string | undefined> {
  const session = input.session;
  if (session.lineage.kind === "child" && session.lineage.origin.kind === "side_thread") {
    if (!session.sessionPath) {
      throw new Error(`side-thread session ${session.sessionId} has no registered transcript`);
    }
    return session.sessionPath;
  }
  if (!session.cwd?.trim()) {
    throw new Error(`session ${session.sessionId} has no daemon-owned cwd`);
  }

  const store = new SparkSessionStore({ cwd: session.cwd, sparkHome: input.sparkHome });
  if (session.sessionPath) {
    const record = await store.load(session.sessionPath);
    assertTranscriptIdentity(record.header.id, record.header.cwd, session);
    return resolve(session.sessionPath);
  }

  const recovered = await store.findAllById(session.sessionId);
  if (recovered.length > 1) {
    throw new Error(
      `session ${session.sessionId} has ${recovered.length} transcript fragments; run transcript unification before continuing`,
    );
  }
  const record = recovered[0];
  if (!record) return undefined;
  assertTranscriptIdentity(record.header.id, record.header.cwd, session);
  return record.path;
}

/**
 * Resolve the one transcript owned by a daemon registry record.
 *
 * Ordinary conversations are preallocated at a stable path before execution.
 * Side-thread generations retain their explicitly registered generation path.
 */
export async function ensureDaemonSessionTranscript(
  input: EnsureDaemonSessionTranscriptInput,
): Promise<string> {
  const session = input.session;
  const existingPath = await resolveDaemonSessionTranscript(input);
  if (existingPath) {
    if (
      session.sessionPath ||
      (session.lineage.kind === "child" && session.lineage.origin.kind === "side_thread")
    ) {
      return existingPath;
    }
    const bound = await input.registry.bindTranscriptPath({
      sessionId: session.sessionId,
      sessionPath: existingPath,
      ...(input.expectedIncarnation === undefined
        ? {}
        : { expectedIncarnation: input.expectedIncarnation }),
      ...(input.expectedLifecycle ? { expectedLifecycle: input.expectedLifecycle } : {}),
    });
    return bound.sessionPath!;
  }

  const store = new SparkSessionStore({ cwd: session.cwd!, sparkHome: input.sparkHome });
  const record = store.createCanonicalSession({
    id: session.sessionId,
    timestamp: session.createdAt,
  });
  await store.save(record);
  const bound = await input.registry.bindTranscriptPath({
    sessionId: session.sessionId,
    sessionPath: record.path,
    ...(input.expectedIncarnation === undefined
      ? {}
      : { expectedIncarnation: input.expectedIncarnation }),
    ...(input.expectedLifecycle ? { expectedLifecycle: input.expectedLifecycle } : {}),
  });
  return bound.sessionPath!;
}

function assertTranscriptIdentity(
  transcriptId: string,
  transcriptCwd: string,
  session: SparkSessionState,
): void {
  if (transcriptId !== session.sessionId) {
    throw new Error(`registered transcript belongs to ${transcriptId}, not ${session.sessionId}`);
  }
  if (resolve(transcriptCwd) !== resolve(session.cwd!)) {
    throw new Error(`registered transcript for ${session.sessionId} belongs to another workspace`);
  }
}
