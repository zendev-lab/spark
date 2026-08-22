import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
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
import {
  resolveSessionCwdForWorkspaceId,
  resolveSessionCwdOwner,
  SessionCwdResolutionError,
} from "../../session-cwd.ts";
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
      | "workspace.directory.list"
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
    case "workspace.directory.list":
      return await listWorkspaceDirectory(ctx, request.params);
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

async function listWorkspaceDirectory(
  ctx: LocalRpcDispatchContext,
  input: {
    workspaceId: string;
    cwdArtifactRef?: string;
    relativePath: string;
    includeHidden: boolean;
    limit: number;
  },
) {
  const relativePath = normalizedRelativeDirectory(input.relativePath);
  let resolved;
  try {
    resolved = await resolveSessionCwdForWorkspaceId(ctx.db, {
      workspaceId: input.workspaceId,
      ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
      ...(relativePath ? { cwd: relativePath } : {}),
    });
  } catch (error) {
    if (error instanceof SessionCwdResolutionError) {
      throw new SparkDaemonControlError("workspace_cwd_invalid", error.message);
    }
    throw error;
  }

  const selected: string[] = [];
  let visibleEntries = 0;
  const directory = await opendir(resolved.cwd);
  for await (const entry of directory) {
    if (!input.includeHidden && entry.name.startsWith(".")) continue;
    visibleEntries += 1;
    insertBoundedDirectoryName(selected, entry.name, input.limit);
  }
  const entries = await Promise.all(
    selected.map(async (name) => {
      const childRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const candidate = join(resolved.cwd, name);
      const info = await lstat(candidate).catch(() => null);
      if (!info) {
        return directoryEntry(input, childRelativePath, name, "file", false, "unavailable");
      }
      if (info.isDirectory()) {
        return directoryEntry(input, childRelativePath, name, "directory", true);
      }
      if (!info.isSymbolicLink()) {
        return directoryEntry(input, childRelativePath, name, "file", false, "not_directory");
      }
      try {
        await resolveSessionCwdForWorkspaceId(ctx.db, {
          workspaceId: input.workspaceId,
          ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
          cwd: childRelativePath,
        });
        return directoryEntry(input, childRelativePath, name, "symlink", true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return directoryEntry(
          input,
          childRelativePath,
          name,
          "symlink",
          false,
          message.includes("escapes") || message.includes("must be inside")
            ? "symlink_escape"
            : message.includes("not a directory")
              ? "not_directory"
              : "unavailable",
        );
      }
    }),
  );
  return {
    workspaceId: input.workspaceId,
    rootRef: directoryRootRef(input.workspaceId, input.cwdArtifactRef),
    ...(input.cwdArtifactRef ? { cwdArtifactRef: input.cwdArtifactRef } : {}),
    current: {
      ref: directoryRef(input.workspaceId, input.cwdArtifactRef, relativePath),
      relativePath,
    },
    entries,
    truncated: visibleEntries > selected.length,
    observedAt: new Date().toISOString(),
  };
}

function insertBoundedDirectoryName(names: string[], name: string, limit: number): void {
  let low = 0;
  let high = names.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (name.localeCompare(names[middle]!) > 0) low = middle + 1;
    else high = middle;
  }
  if (low >= limit) return;
  names.splice(low, 0, name);
  if (names.length > limit) names.pop();
}

function normalizedRelativeDirectory(value: string): string {
  const segments = value.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new SparkDaemonControlError(
      "workspace_cwd_invalid",
      "Directory traversal outside the selected owner root is not allowed.",
    );
  }
  return segments.join("/");
}

function directoryEntry(
  input: { workspaceId: string; cwdArtifactRef?: string },
  relativePath: string,
  name: string,
  kind: "directory" | "file" | "symlink",
  selectable: boolean,
  blockedReason?: "not_directory" | "symlink_escape" | "unavailable",
) {
  return {
    ref: directoryRef(input.workspaceId, input.cwdArtifactRef, relativePath),
    name,
    relativePath,
    kind,
    selectable,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function directoryRootRef(workspaceId: string, cwdArtifactRef?: string): string {
  return `directory-root:${opaqueDirectoryIdentity([workspaceId, cwdArtifactRef ?? "workspace"])}`;
}

function directoryRef(
  workspaceId: string,
  cwdArtifactRef: string | undefined,
  relativePath: string,
): string {
  return `directory:${opaqueDirectoryIdentity([workspaceId, cwdArtifactRef ?? "workspace", relativePath])}`;
}

function opaqueDirectoryIdentity(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
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
