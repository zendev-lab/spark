import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSparkSessionProjection } from "@zendev-lab/spark-protocol";
import {
  loadSparkSessionSnapshotTail,
  refreshSparkSessionSnapshotIndex,
} from "@zendev-lab/spark-session";

export const TRANSCRIPT_ENTRY_COUNT = 10_000;
export const TAIL_MESSAGE_LIMIT = 32;

function sessionControlFields(supervisorSessionId: string) {
  return {
    incarnation: 1,
    activity: "idle" as const,
    lifetime: "scoped" as const,
    stateBinding: { kind: "session" as const, ref: supervisorSessionId },
    visibility: "public" as const,
    retention: "retain" as const,
    purpose: "interactive",
  };
}

export async function createIndexedTranscript(sessionId: string) {
  const root = await mkdtemp(join(tmpdir(), "spark-session-bench-"));
  const transcriptPath = join(root, "session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: "2026-08-03T00:00:00.000Z",
      cwd: root,
    }),
  ];
  let parentId: string | null = null;
  for (let index = 0; index < TRANSCRIPT_ENTRY_COUNT; index += 1) {
    const id = `message-${index}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: "2026-08-03T00:00:01.000Z",
        message: { role: "user", content: `消息 ${index}` },
      }),
    );
    parentId = id;
  }
  await writeFile(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  const session = parseSparkSessionProjection({
    sessionId,
    scope: { kind: "workspace", workspaceId: "ws_bench" },
    lifecycle: "open",
    placement: "active",
    roleBinding: { kind: "none" },
    owner: { kind: "session", supervisorSessionId: "sess_admin_ws_bench" },
    ...sessionControlFields("sess_admin_ws_bench"),
    sessionPath: transcriptPath,
    bindings: [],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:01.000Z",
  });
  const refreshed = await refreshSparkSessionSnapshotIndex({
    sessionPath: transcriptPath,
    sessionId,
  });
  return { root, transcriptPath, session, refreshed };
}

export async function runRefreshSparkSessionSnapshotIndex(input: {
  sessionPath: string;
  sessionId: string;
}) {
  return refreshSparkSessionSnapshotIndex(input);
}

export async function runLoadSparkSessionSnapshotTail(input: {
  sessionsRoot: string;
  session: ReturnType<typeof parseSparkSessionProjection>;
}) {
  return loadSparkSessionSnapshotTail({
    ...input,
    messageLimit: TAIL_MESSAGE_LIMIT,
    resolveGitBranch: async () => undefined,
  });
}
