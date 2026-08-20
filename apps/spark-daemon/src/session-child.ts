import { stat, unlink } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";

import {
  SparkSessionStore,
  stableSparkSessionContextEntries,
  type SparkSessionEntry,
} from "@zendev-lab/spark-session/transcript";
import { createId, type SparkSessionState } from "@zendev-lab/spark-protocol";
import { createSparkRoleRegistry } from "@zendev-lab/spark-roles";
import { SparkSessionRegistryError } from "@zendev-lab/spark-session";

import { resolveSessionCwdForWorkspaceId } from "./session-cwd.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { resolveDaemonSessionTranscript } from "./session-transcript-control.ts";

export type ManagedChildSessionSeed = "fresh" | "fork";

export interface CreateManagedChildSessionInput {
  db: DatabaseSync;
  registry: DaemonSessionRegistry;
  sparkHome: string;
  supervisorSessionId: string;
  roleRef: string;
  seed: ManagedChildSessionSeed;
  name?: string;
  cwd?: string;
  cwdArtifactRef?: string;
}

interface TranscriptCheckpoint {
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
}

/**
 * Create one ordinary daemon-owned child Session without starting an
 * Invocation. Both public spawn and fork actions delegate here; their only
 * difference is whether the child's independent transcript receives a stable
 * copy of the supervisor transcript.
 */
export async function createManagedChildSession(
  input: CreateManagedChildSessionInput,
): Promise<SparkSessionState> {
  const supervisor = await requireEligibleSupervisor(input.registry, input.supervisorSessionId);
  if (supervisor.scope.kind !== "workspace") {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "managed child Sessions require a workspace supervisor",
    );
  }
  if (supervisor.lineage.kind === "child" && supervisor.lineage.origin.kind === "invocation") {
    throw new SparkSessionRegistryError(
      "invalid_scope",
      "ephemeral invocation Sessions cannot supervise managed child Sessions",
    );
  }

  const resolvedCwd = await resolveSessionCwdForWorkspaceId(input.db, {
    workspaceId: supervisor.scope.workspaceId,
    cwd: input.cwd ?? supervisor.cwd,
    cwdArtifactRef: input.cwdArtifactRef ?? supervisor.cwdArtifactRef,
  });
  await requireExactRole(input.roleRef, resolvedCwd.cwd);

  const parentTranscriptPath =
    input.seed === "fork"
      ? await resolveDaemonSessionTranscript({
          session: supervisor,
          sparkHome: input.sparkHome,
        })
      : undefined;
  const entries =
    input.seed === "fork" && parentTranscriptPath
      ? await loadStableForkEntries(supervisor, input.sparkHome, parentTranscriptPath)
      : [];

  const sessionId = createId("sess");
  const store = new SparkSessionStore({ cwd: resolvedCwd.cwd, sparkHome: input.sparkHome });
  const record = store.createCanonicalSession({
    id: sessionId,
    ...(parentTranscriptPath ? { parentSession: parentTranscriptPath } : {}),
  });
  record.entries = entries;
  await store.save(record);

  try {
    return await input.registry.create({
      sessionId,
      scope: supervisor.scope,
      supervisorSessionId: supervisor.sessionId,
      placement: "child",
      roleBinding: { kind: "explicit", roleRef: input.roleRef },
      sessionPath: record.path,
      cwd: resolvedCwd.cwd,
      ...(resolvedCwd.cwdArtifactRef ? { cwdArtifactRef: resolvedCwd.cwdArtifactRef } : {}),
      ...(input.name ? { name: input.name } : {}),
    });
  } catch (error) {
    try {
      await unlink(record.path);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `failed to register child Session ${sessionId} and remove its transcript`,
      );
    }
    throw error;
  }
}

async function requireEligibleSupervisor(
  registry: DaemonSessionRegistry,
  sessionId: string,
): Promise<SparkSessionState> {
  const session = await registry.get(sessionId);
  if (!session) {
    throw new SparkSessionRegistryError(
      "session_owner_not_found",
      `unknown supervising Session: ${sessionId}`,
    );
  }
  if (session.lifecycle !== "open") {
    throw new SparkSessionRegistryError(
      session.lifecycle === "closing" ? "session_closing" : "session_closed",
      `cannot create a child from ${session.lifecycle} Session ${sessionId}`,
    );
  }
  if (session.placement === "archived") {
    throw new SparkSessionRegistryError(
      "session_archived",
      `cannot create a child from archived Session ${sessionId}`,
    );
  }
  if (session.bindings.length > 0) {
    throw new SparkSessionRegistryError(
      "session_channel_bound",
      `channel-bound Session ${sessionId} cannot create child Sessions`,
    );
  }
  return session;
}

async function requireExactRole(roleRef: string, cwd: string): Promise<void> {
  if (!roleRef.startsWith("role:")) {
    throw new SparkSessionRegistryError(
      "invalid_session_role",
      "managed child Sessions require an exact RoleRef",
    );
  }
  try {
    (await createSparkRoleRegistry(cwd)).get(roleRef);
  } catch (error) {
    throw new SparkSessionRegistryError(
      "invalid_session_role",
      `Session Role is not defined: ${roleRef}; ${errorMessage(error)}`,
    );
  }
}

async function loadStableForkEntries(
  supervisor: SparkSessionState,
  sparkHome: string,
  transcriptPath: string,
): Promise<SparkSessionEntry[]> {
  const store = new SparkSessionStore({ cwd: supervisor.cwd!, sparkHome });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await readCheckpoint(transcriptPath);
    if (!before) continue;
    let record;
    try {
      record = await store.load(transcriptPath);
    } catch (error) {
      const afterFailure = await readCheckpoint(transcriptPath);
      if (!sameCheckpoint(before, afterFailure)) continue;
      throw new SparkSessionRegistryError(
        "session_transcript_conflict",
        `cannot read transcript for ${supervisor.sessionId}: ${errorMessage(error)}`,
      );
    }
    const after = await readCheckpoint(transcriptPath);
    if (!sameCheckpoint(before, after)) continue;
    if (record.header.id !== supervisor.sessionId) {
      throw new SparkSessionRegistryError(
        "session_transcript_conflict",
        `transcript ${transcriptPath} belongs to ${record.header.id}, not ${supervisor.sessionId}`,
      );
    }
    return stableSparkSessionContextEntries(record.entries).map((entry) => structuredClone(entry));
  }
  throw new SparkSessionRegistryError(
    "session_transcript_changed",
    `transcript for ${supervisor.sessionId} changed while it was being forked`,
  );
}

async function readCheckpoint(path: string): Promise<TranscriptCheckpoint | undefined> {
  try {
    const info = await stat(path);
    return {
      device: info.dev,
      inode: info.ino,
      size: info.size,
      modifiedAtMs: info.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new SparkSessionRegistryError(
      "session_transcript_conflict",
      `cannot inspect transcript ${path}: ${errorMessage(error)}`,
    );
  }
}

function sameCheckpoint(
  left: TranscriptCheckpoint,
  right: TranscriptCheckpoint | undefined,
): boolean {
  return (
    right !== undefined &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
