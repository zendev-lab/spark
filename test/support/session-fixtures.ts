import {
  parseSparkSessionProjection,
  type SparkModelRef,
  type SparkSessionChannelBinding,
  type SparkSessionProjection,
  type SparkSessionRoleBinding,
  type SparkSessionState,
  type SparkThinkingLevel,
} from "@zendev-lab/spark-protocol";

const defaultTimestamp = "2026-07-01T00:00:00.000Z";

export function workspaceSessionRecord(input: {
  sessionId: string;
  workspaceId: string;
  name?: string;
  supervisorSessionId?: string;
  administrator?: boolean;
  lifecycle?: "open" | "closing" | "closed";
  placement?: "active" | "archived";
  activity?: "idle" | "queued" | "running";
  roleBinding?: SparkSessionRoleBinding;
  bindings?: SparkSessionChannelBinding[];
  cwd?: string;
  cwdArtifactRef?: `artifact:${string}`;
  sessionPath?: string;
  model?: SparkModelRef;
  thinkingLevel?: SparkThinkingLevel;
  maxOutputTokens?: number;
  createdAt?: string;
  updatedAt?: string;
}): SparkSessionProjection {
  const administrator = input.administrator === true;
  return parseSparkSessionProjection({
    sessionId: input.sessionId,
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    lifecycle: input.lifecycle ?? "open",
    placement: input.placement ?? "active",
    activity: input.activity ?? "idle",
    lifetime: administrator ? "persistent" : "scoped",
    roleBinding: administrator
      ? { kind: "explicit", roleRef: "role:builtin-administrator" }
      : (input.roleBinding ?? { kind: "none" }),
    lineage: administrator
      ? { kind: "root" }
      : {
          kind: "child",
          parentSessionId:
            input.supervisorSessionId ??
            `sess_admin_${input.workspaceId.replace(/[^a-z0-9]+/giu, "_")}`,
          origin: { kind: "session" },
        },
    incarnation: 1,
    visibility: "public",
    retention: administrator ? "audit" : "retain",
    purpose: administrator ? "workspace_administrator" : "interactive",
    bindings: input.bindings ?? [],
    tags: [],
    archiveHistory: [],
    ...(input.name || administrator ? { name: input.name ?? "Administrator" } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    createdAt: input.createdAt ?? defaultTimestamp,
    updatedAt: input.updatedAt ?? input.createdAt ?? defaultTimestamp,
  });
}

export async function createDaemonWorkspaceSession(
  registry: {
    ensureWorkspaceAdministrator(workspaceId: string): Promise<SparkSessionState>;
    create(input: {
      sessionId?: string;
      scope: { kind: "workspace"; workspaceId: string };
      supervisorSessionId: string;
      placement?: "child" | "sibling";
      name?: string;
      roleBinding?: SparkSessionRoleBinding;
      cwd?: string;
      sessionPath?: string;
      maxOutputTokens?: number;
    }): Promise<SparkSessionState>;
  },
  input: {
    sessionId?: string;
    workspaceId: string;
    name?: string;
    roleBinding?: SparkSessionRoleBinding;
    cwd?: string;
    sessionPath?: string;
    maxOutputTokens?: number;
  },
): Promise<SparkSessionState> {
  const administrator = await registry.ensureWorkspaceAdministrator(input.workspaceId);
  return await registry.create({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    scope: { kind: "workspace", workspaceId: input.workspaceId },
    supervisorSessionId: administrator.sessionId,
    placement: "child",
    ...(input.name ? { name: input.name } : {}),
    ...(input.roleBinding ? { roleBinding: input.roleBinding } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
  });
}
