import { registerSparkReproRoles } from "./product/policy/spark-repro-roles.ts";
import {
  sparkTurnSubmitResultSchema,
  type SparkEvidenceAnswerEvent,
} from "@zendev-lab/spark-protocol";
import type { SparkPaths } from "@zendev-lab/spark-system";
import type { DatabaseSync } from "node:sqlite";
import type { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import { SparkReproOwner, type SparkReproOwnerOptions } from "./repro-owner.ts";
import { projectDaemonSparkReproV10 } from "./repro-projection.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import { executeSparkDaemonSessionControl } from "./session-control.ts";
import type { SessionSupervisor } from "./session-supervisor.ts";
import { SparkReproV10Store } from "./store/repro-v10.ts";
import { getWorkspaceById, type SparkDaemonWorkspace } from "./store/workspaces.ts";

export interface DaemonSparkReproRuntimeDeps {
  paths: SparkPaths;
  db: DatabaseSync;
  sessionRegistry: DaemonSessionRegistry;
  modelControl: SparkDaemonModelControl;
  sessionSupervisor?: SessionSupervisor;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  onInvocationQueued?: () => void;
  onProjectionNeeded?: SparkReproOwnerOptions["onProjectionNeeded"];
}

export function createDaemonSparkReproOwner(
  input: DaemonSparkReproRuntimeDeps & {
    workspace: SparkDaemonWorkspace;
  },
): SparkReproOwner {
  registerSparkReproRoles();
  return new SparkReproOwner({
    db: input.db,
    workspace: input.workspace,
    sessionRegistry: input.sessionRegistry,
    modelControl: input.modelControl,
    ...(input.sessionSupervisor ? { sessionSupervisor: input.sessionSupervisor } : {}),
    ...(input.humanWaits ? { humanWaits: input.humanWaits } : {}),
    onProjectionNeeded:
      input.onProjectionNeeded ??
      (async (repro) => {
        await projectDaemonSparkReproV10({ db: input.db, workspace: input.workspace, repro });
      }),
    submitTurn: async (request) => {
      const executed = await executeSparkDaemonSessionControl(
        {
          paths: input.paths,
          db: input.db,
          sessionRegistry: input.sessionRegistry,
          ...(input.sessionSupervisor ? { sessionSupervisor: input.sessionSupervisor } : {}),
          modelControl: input.modelControl,
          ...(input.onInvocationQueued ? { onInvocationQueued: input.onInvocationQueued } : {}),
          actor: "spark-daemon-runtime-ws",
        },
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: request.sessionId,
          idempotencyKey: request.idempotencyKey,
          payload: {
            sessionId: request.sessionId,
            prompt: request.prompt,
            idempotencyKey: request.idempotencyKey,
            assignment: request.assignment,
            messageMetadata: request.messageMetadata,
          },
        },
      );
      return sparkTurnSubmitResultSchema.parse(executed.result);
    },
  });
}

export async function reconcileDaemonSparkRepros(
  input: DaemonSparkReproRuntimeDeps & { sessionId?: string },
): Promise<number> {
  const recoverable = new SparkReproV10Store(input.db)
    .listRecoverable()
    .filter(
      (repro) =>
        !input.sessionId ||
        Object.values(repro.lanes).some((lane) => lane.sessionId === input.sessionId),
    );
  let changed = 0;
  for (const repro of recoverable) {
    const workspace = getWorkspaceById(input.db, repro.workspaceId);
    if (!workspace || workspace.lifecycle) {
      throw new Error(`Repro ${repro.reproId} Workspace is unavailable`);
    }
    const reconciled = await createDaemonSparkReproOwner({ ...input, workspace }).reconcile(
      repro.reproId,
    );
    if (reconciled.changed) changed += 1;
  }
  return changed;
}

export async function resumeDaemonSparkReproAnswer(
  input: DaemonSparkReproRuntimeDeps,
  event: SparkEvidenceAnswerEvent,
): Promise<boolean> {
  if (event.binding.modeScope !== "repro") return false;
  const repro = new SparkReproV10Store(input.db).get(event.binding.goalOrReproId);
  if (!repro) return false;
  const workspace = getWorkspaceById(input.db, repro.workspaceId);
  if (!workspace || workspace.lifecycle) {
    throw new Error(`Repro ${repro.reproId} Workspace is unavailable`);
  }
  await createDaemonSparkReproOwner({ ...input, workspace }).resumeAnswer(event);
  return true;
}
