import {
  applyWorkspaceLifecycleMutation,
  attachWorkspace,
  attachWorkspaceClient,
  ensureLocalWorkspace,
  ensureWorkspaceExecutorClient,
  heartbeatWorkspaceClient,
  listWorkspaces,
  planWorkspaceRegistration,
  planWorkspaceLifecycleMutation,
  registerWorkspace,
  releaseWorkspaceClient,
  stopWorkspace,
} from "../../store/workspaces.js";
import { SparkDaemonControlError } from "../../control-error.ts";
import { resolveSessionCwdOwner, SessionCwdResolutionError } from "../../session-cwd.ts";
import { relocateSparkDaemonHub } from "../../relocation.ts";
import { scheduledSparkDaemonHubOrigin } from "../../server-profiles.ts";
import { ensureWorkspaceAdministratorSession } from "../../workspace-administrator-session.ts";
import { workspaceClientResult } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type WorkspaceRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "workspace.list"
      | "workspace.ensure-local"
      | "workspace.resolve-session-cwd"
      | "workspace.relocate"
      | "workspace.transfer.pending"
      | "workspace.transfer.respond"
      | "workspace.register"
      | "workspace.attach"
      | "workspace.stop"
      | "workspace.lifecycle"
      | "workspace.client.attach"
      | "workspace.client.heartbeat"
      | "workspace.client.release"
      | "workspace.executor.ensure";
  }
>;

export async function handleWorkspaceRequest(
  ctx: LocalRpcDispatchContext,
  request: WorkspaceRequest,
): Promise<LocalRpcServiceOutput<WorkspaceRequest>> {
  const {
    paths,
    db,
    options,
    ensureRegistration,
    verifyWorkspaceConnection,
    unbindWorkspaceFromHub,
  } = ctx;
  switch (request.method) {
    case "workspace.list":
      return parseLocalRpcServiceOutput(request.method, {
        workspaces: listWorkspaces(db, {
          includeInactive: request.params.includeInactive === true,
        }),
        observedAt: new Date().toISOString(),
      });
    case "workspace.ensure-local": {
      // Compatibility method name: resolve/re-attach an explicit registration only.
      const workspace = ensureLocalWorkspace(db, request.params);
      if (options.sessionRegistry) {
        await ensureWorkspaceAdministratorSession(db, options.sessionRegistry, workspace.id);
      }
      return parseLocalRpcServiceOutput(request.method, workspace);
    }
    case "workspace.resolve-session-cwd":
      try {
        return parseLocalRpcServiceOutput(
          request.method,
          await resolveSessionCwdOwner(db, request.params.cwd),
        );
      } catch (error) {
        if (error instanceof SessionCwdResolutionError) {
          throw new SparkDaemonControlError("workspace_cwd_invalid", error.message);
        }
        throw error;
      }
    case "workspace.relocate":
      return (options.relocateSparkDaemonHub ?? relocateSparkDaemonHub)(paths, db, request.params, {
        onUplinkReconfigure: options.onUplinkReconfigure,
      });
    case "workspace.transfer.pending":
      return {
        pending: pendingWorkspaceTransfers(options.leaseTransfers, request.params.workspaceId),
        observedAt: new Date().toISOString(),
      };
    case "workspace.transfer.respond": {
      const transfers = options.leaseTransfers;
      if (!transfers) {
        throw new SparkDaemonControlError(
          "workspace_transfer_unavailable",
          "Lease transfer broker is not available on this daemon.",
        );
      }
      const settlement = transfers.respond(
        request.params.transferId,
        request.params.decision,
        request.params.source === "tui" || request.params.source === "cli"
          ? request.params.source
          : "unknown",
      );
      if (!settlement) {
        throw new SparkDaemonControlError(
          "workspace_transfer_not_found",
          `Unknown or already settled lease transfer: ${request.params.transferId}`,
        );
      }
      return settlement;
    }
    case "workspace.register": {
      // A workspace-scoped one-time token is explicit authority to move the
      // Hub projection to another daemon-owned directory. Preserve the
      // daemon-local workspace id so existing sessions keep resolving after
      // correcting or intentionally changing its path.
      const allowLocalPathRebind = Boolean(request.params.registrationToken);
      const scheduled = scheduledSparkDaemonHubOrigin(
        paths,
        request.params.registrationToken ? request.params.serverUrl : undefined,
      );
      if (request.params.registrationToken && scheduled.ambiguous) {
        throw new SparkDaemonControlError(
          "workspace_registration_failed",
          "This daemon has multiple Hub origins. Pass --server-url to select which origin to project onto.",
        );
      }
      const hubUrl = request.params.registrationToken ? (scheduled.serverUrl ?? "").trim() : "";
      const planned = planWorkspaceRegistration(db, {
        ...request.params,
        serverUrl: hubUrl,
        ...(allowLocalPathRebind ? { allowLocalPathRebind: true } : {}),
      });
      if (request.params.registrationToken && !hubUrl) {
        throw new SparkDaemonControlError(
          "workspace_registration_failed",
          "Hub workspace token requires a daemon Hub origin. Run spark daemon login --server-url <url>.",
        );
      }
      if (!hubUrl) {
        const workspace = registerWorkspace(db, {
          ...request.params,
          serverUrl: "",
          ...(allowLocalPathRebind ? { allowLocalPathRebind: true } : {}),
        });
        if (options.sessionRegistry) {
          await ensureWorkspaceAdministratorSession(db, options.sessionRegistry, workspace.id);
        }
        return parseLocalRpcServiceOutput(request.method, workspace);
      }
      if (planned.previousServerUrl && planned.previousServerBindingId) {
        await unbindWorkspaceFromHub(paths, {
          serverUrl: planned.previousServerUrl,
          bindingId: planned.previousServerBindingId,
          // Credentials were already provisioned for this origin. This only
          // permits completing the explicit local rebind on a trusted legacy
          // HTTP Hub; new target registration keeps its own URL guard.
          allowInsecureHttp: true,
        });
      }
      const serviceRegistration = await ensureRegistration(paths, {
        serverUrl: planned.serverUrl,
        ...(request.params.allowInsecureHttp ? { allowInsecureHttp: true } : {}),
        workspaceRegistration: {
          localWorkspaceKey: planned.localWorkspaceKey,
          localPath: planned.localPath,
          displayName: planned.displayName,
          workspaceName: planned.workspaceName,
          workspaceSlug: planned.workspaceSlug,
        },
        ...(request.params.registrationToken
          ? { registrationToken: request.params.registrationToken }
          : {}),
      });
      if (!serviceRegistration.workspaceBinding) {
        throw new SparkDaemonControlError(
          "workspace_registration_failed",
          "Workspace registration did not return a server workspace connection.",
        );
      }
      await verifyWorkspaceConnection({
        config: serviceRegistration.config,
        workspaceBinding: serviceRegistration.workspaceBinding,
        localPath: planned.localPath,
      });
      const workspace = registerWorkspace(db, {
        ...request.params,
        serverUrl: planned.serverUrl,
        ...(allowLocalPathRebind ? { allowLocalPathRebind: true } : {}),
        ...(request.params.registrationToken
          ? { consumedRegistrationToken: request.params.registrationToken }
          : {}),
        ...(serviceRegistration.config.runtimeId && serviceRegistration.config.runtimeToken
          ? {
              serverCredential: {
                runtimeId: serviceRegistration.config.runtimeId,
                runtimeToken: serviceRegistration.config.runtimeToken,
                ...(serviceRegistration.config.runtimeTokenExpiresAt
                  ? { runtimeTokenExpiresAt: serviceRegistration.config.runtimeTokenExpiresAt }
                  : {}),
                ...(serviceRegistration.config.refreshToken
                  ? { refreshToken: serviceRegistration.config.refreshToken }
                  : {}),
                ...(serviceRegistration.config.refreshTokenExpiresAt
                  ? { refreshTokenExpiresAt: serviceRegistration.config.refreshTokenExpiresAt }
                  : {}),
              },
            }
          : {}),
        ...(serviceRegistration.workspaceBinding
          ? {
              serverWorkspaceId: serviceRegistration.workspaceBinding.workspaceId,
              serverBindingId: serviceRegistration.workspaceBinding.bindingId,
              serverStatus: serviceRegistration.workspaceBinding.status,
            }
          : {}),
      });
      if (planned.previousServerUrl) {
        options.onUplinkReconfigure?.(planned.previousServerUrl);
      }
      options.onUplinkReconfigure?.(workspace.serverUrl);
      if (options.sessionRegistry) {
        await ensureWorkspaceAdministratorSession(db, options.sessionRegistry, workspace.id);
      }
      return parseLocalRpcServiceOutput(request.method, {
        ...workspace,
        ...(serviceRegistration.workspaceAuthorization
          ? { workspaceAuthorization: serviceRegistration.workspaceAuthorization }
          : {}),
      });
    }
    case "workspace.attach": {
      const workspace = attachWorkspace(db, { id: request.params.id });
      options.onUplinkReconfigure?.(workspace.serverUrl);
      if (options.sessionRegistry) {
        await ensureWorkspaceAdministratorSession(db, options.sessionRegistry, workspace.id);
      }
      return parseLocalRpcServiceOutput(request.method, workspace);
    }
    case "workspace.stop": {
      const workspace = stopWorkspace(db, { id: request.params.id });
      options.onUplinkReconfigure?.(workspace.serverUrl);
      return parseLocalRpcServiceOutput(request.method, workspace);
    }
    case "workspace.lifecycle": {
      const { dryRun: _dryRun, ...mutation } = request.params;
      const plan = planWorkspaceLifecycleMutation(db, mutation);
      if (request.params.dryRun) {
        return parseLocalRpcServiceOutput(request.method, plan);
      }
      if (
        mutation.action === "unregister" &&
        !plan.workspace.lifecycle &&
        plan.workspace.serverUrl &&
        plan.workspace.serverBindingId
      ) {
        await unbindWorkspaceFromHub(paths, {
          serverUrl: plan.workspace.serverUrl,
          bindingId: plan.workspace.serverBindingId,
          allowInsecureHttp: true,
        });
      }
      const result = applyWorkspaceLifecycleMutation(db, mutation);
      options.onUplinkReconfigure?.(plan.workspace.serverUrl);
      return parseLocalRpcServiceOutput(request.method, result);
    }
    case "workspace.client.attach": {
      const client = attachWorkspaceClient(db, request.params);
      return parseLocalRpcServiceOutput(request.method, workspaceClientResult(db, client));
    }
    case "workspace.client.heartbeat": {
      const client = heartbeatWorkspaceClient(db, request.params);
      return parseLocalRpcServiceOutput(request.method, workspaceClientResult(db, client));
    }
    case "workspace.client.release": {
      const client = releaseWorkspaceClient(db, request.params);
      return parseLocalRpcServiceOutput(request.method, workspaceClientResult(db, client));
    }
    case "workspace.executor.ensure": {
      const client = ensureWorkspaceExecutorClient(db, request.params);
      return parseLocalRpcServiceOutput(request.method, workspaceClientResult(db, client));
    }
    default:
      return unreachableWorkspaceRequest(request);
  }
}

function unreachableWorkspaceRequest(request: never): never {
  throw new Error(`Unsupported workspace RPC request: ${String(request)}`);
}

function pendingWorkspaceTransfers(
  transfers: LocalRpcDispatchContext["options"]["leaseTransfers"],
  workspaceId?: string,
) {
  if (!transfers) return [];
  if (!workspaceId) return transfers.listPending();
  const item = transfers.pendingForWorkspace(workspaceId);
  return item ? [item] : [];
}
