import { error as httpError, fail, redirect } from "@sveltejs/kit";
import { createId, sparkSessionModeSchema } from "@zendev-lab/spark-protocol";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { titleFromPrompt } from "@zendev-lab/spark-hub-coordination/agents-product";
import {
  cancelConversationTurnForHub,
  submitConversationTurnForHub,
} from "$lib/server/conversation-control";
import { formText } from "$lib/server/form-data";
import {
  TurnAttachmentValidationError,
  attachmentPrompt,
  turnAttachmentsFromFormData,
} from "$lib/server/turn-attachments";
import { getDatabase } from "$lib/server/db";
import { requireWorkspaceByRouteId } from "$lib/server/workspace-routing";
import { conversationStartSessionId } from "$lib/server/conversation-submission";
import {
  archiveManagedSessionForHub,
  closeManagedSessionForHub,
  createManagedSessionForHub,
  getManagedSessionForHub,
  getProjectedManagedSessionForHub,
  setManagedSessionModeForHub,
  listProjectedManagedSessionsForHub,
} from "$lib/server/managed-sessions";
import {
  loadModelControlForHub,
  loadProjectedModelControlForHub,
  modelValue,
  parseModelValue,
  parseThinkingLevelValue,
  setSessionModelForHub,
  setSessionThinkingLevelForHub,
} from "$lib/server/model-control";
import {
  hubSubmissionIdempotencyKey,
  createHubSubmissionId,
} from "$lib/server/submission-idempotency";
import { workspaceIdForWorkbenchSession } from "$lib/workbench-session-scope";
import { sessionHasChannelBinding } from "$lib/channel-session-title";
import { hubSlashSubmissionError } from "$lib/slash-actions";
import { workbenchSessionsPathFromPathname, workspaceSessionsPath } from "$lib/workspace-routes";
import type { Actions } from "@sveltejs/kit";
import type { Cookies } from "@sveltejs/kit";
import type { HubConversationSummary } from "$lib/server/conversation-summaries";

interface SessionsPageParentData {
  activeWorkspace?: { id: string; slug: string } | null;
  sessions: HubConversationSummary[];
  sessionsAvailable: boolean;
  sessionControlAvailable: boolean;
}

export interface SessionsPageLoadEvent {
  parent: () => Promise<SessionsPageParentData>;
  url: URL;
}

export async function loadSessionsPage(
  { parent, url }: SessionsPageLoadEvent,
  expectedWorkspaceId?: string,
) {
  const parentData = await parent();
  if (expectedWorkspaceId && parentData.activeWorkspace?.id !== expectedWorkspaceId) {
    throw httpError(404, "Workspace not found.");
  }
  if (url?.pathname === "/sessions" && parentData.activeWorkspace) {
    redirect(303, `${workspaceSessionsPath(parentData.activeWorkspace)}${url.search}`);
  }
  const administrator = parentData.sessions.find((session) => session.lineage.kind === "root");
  if (!url.searchParams.has("new") && administrator && parentData.activeWorkspace) {
    redirect(
      303,
      `${workspaceSessionsPath(parentData.activeWorkspace)}/${encodeURIComponent(administrator.sessionId)}`,
    );
  }
  const workspaceId = parentData.activeWorkspace?.id ?? null;
  const modelControl = workspaceId
    ? parentData.sessionControlAvailable
      ? await loadProjectedModelControlForHub({ workspaceId }).then(async (projected) =>
          projected.available
            ? projected
            : loadModelControlForHub({ workspaceId }).then((control) =>
                control.available ? control : projected,
              ),
        )
      : await loadProjectedModelControlForHub({ workspaceId })
    : { available: false, snapshot: { providers: [], diagnostics: [] } };
  return {
    sessions: parentData.sessions,
    sessionsAvailable: parentData.sessionsAvailable,
    sessionControlAvailable: parentData.sessionControlAvailable,
    selectedSessionId: null as string | null,
    startSubmissionIdSeed: createId("idem"),
    sessionActivity: null,
    modelControl,
    sessionCwdRoots: workspaceId ? loadSessionCwdRoots(getDatabase(), workspaceId) : [],
    submissionId: createHubSubmissionId(),
  };
}

interface SessionActionEvent {
  cookies: Cookies;
  params: Record<string, string | undefined>;
  request: Request;
  url: URL;
}

export function loadSessionCwdRoots(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
): Array<{ artifactRef: string; label: string; path: string }> {
  if (typeof db?.prepare !== "function") return [];
  const rows = db
    .prepare(
      `SELECT title, content_ref_json AS contentRefJson
       FROM artifacts
       WHERE workspace_id = ? AND kind = 'git_change'
       ORDER BY updated_at DESC`,
    )
    .all(workspaceId) as Array<{ title: string; contentRefJson: string }>;
  return rows.flatMap((row) => {
    try {
      const contentRef = JSON.parse(row.contentRefJson) as Record<string, unknown>;
      const inlineJson = contentRef.inlineJson;
      const artifactRef = contentRef.artifactRef;
      if (!inlineJson || typeof inlineJson !== "object" || Array.isArray(inlineJson)) return [];
      const worktree = (inlineJson as Record<string, unknown>).worktree;
      if (!worktree || typeof worktree !== "object" || Array.isArray(worktree)) return [];
      const path = (worktree as Record<string, unknown>).path;
      const status = (worktree as Record<string, unknown>).status;
      if (
        typeof artifactRef !== "string" ||
        typeof path !== "string" ||
        (status !== "attached" && status !== "cleanup_blocked")
      ) {
        return [];
      }
      return [{ artifactRef, label: row.title, path }];
    } catch {
      return [];
    }
  });
}

export const actions = {
  startConversation: async ({ cookies, params, request, url }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const workspaceId = formText(formData, "workspaceId").trim();
    const message = formText(formData, "message").trim();
    const model = formText(formData, "model").trim();
    const thinkingLevel = formText(formData, "thinkingLevel").trim();
    const cwd = formText(formData, "cwd").trim();
    const cwdArtifactRef = formText(formData, "cwdArtifactRef").trim();
    const submittedId = formText(formData, "submissionId").trim();
    const submissionId = submittedId || createHubSubmissionId();
    const values = {
      workspaceId,
      cwd,
      cwdArtifactRef,
      message,
      model,
      thinkingLevel,
      submissionId,
    };

    if (!workspaceId) {
      return fail(400, {
        intent: "startConversation",
        success: false,
        error: t.createWorkspaceRequired,
        message: t.createWorkspaceRequired,
        values,
      });
    }
    assertRouteWorkspace(params, workspaceId, "Workspace not found.");
    if (!message) {
      return fail(400, {
        intent: "startConversation",
        success: false,
        error: t.assignGoalRequired,
        message: t.assignGoalRequired,
        values,
      });
    }
    const slashActionError = hubSlashSubmissionError(message, t.workbench.slashActions);
    if (slashActionError) {
      return fail(400, {
        intent: "startConversation",
        success: false,
        error: slashActionError,
        message: slashActionError,
        values,
      });
    }

    let session;
    let deterministicSessionId: string | undefined;
    const cwdContext = cwdArtifactRef || cwd ? JSON.stringify([cwdArtifactRef, cwd]) : "";
    try {
      deterministicSessionId = conversationStartSessionId(workspaceId, submissionId, cwdContext);
      const administrator = listProjectedManagedSessionsForHub({
        workspaceId,
        includeArchived: true,
        related: true,
      }).sessions.find((candidate) => candidate.lineage.kind === "root");
      if (!administrator) {
        throw new Error(`Workspace ${workspaceId} Administrator Session is still provisioning.`);
      }
      session = await createManagedSessionForHub({
        scope: { kind: "workspace", workspaceId },
        supervisorSessionId: administrator.sessionId,
        placement: "child",
        roleBinding: { kind: "none" },
        name: titleFromPrompt(message),
        ...(cwd ? { cwd } : {}),
        ...(cwdArtifactRef ? { cwdArtifactRef } : {}),
        ...(deterministicSessionId ? { sessionId: deterministicSessionId } : {}),
        idempotencyKey: hubSubmissionIdempotencyKey(submissionId, "session.create", cwdContext),
      });
    } catch (caught) {
      if (deterministicSessionId) {
        const existing = await getManagedSessionForHub(deterministicSessionId);
        if (
          existing &&
          existing.placement !== "archived" &&
          workspaceIdForWorkbenchSession(existing) === workspaceId &&
          (existing.cwdArtifactRef ?? "") === cwdArtifactRef
        ) {
          session = existing;
        }
      }
      if (session) {
        // A previous identical HTTP request created this session before its
        // response was lost. Continue with the same turn idempotency key.
      } else {
        const error = caught instanceof Error ? caught.message : t.createFailed;
        return fail(400, {
          intent: "startConversation",
          success: false,
          error,
          message: error,
          values,
        });
      }
    }

    try {
      if (model) await setSessionModelForHub(session.sessionId, parseModelValue(model));
      if (thinkingLevel) {
        await setSessionThinkingLevelForHub(
          session.sessionId,
          parseThinkingLevelValue(thinkingLevel),
        );
      }
      await submitConversationMessage({
        workspaceId,
        sessionId: session.sessionId,
        message,
        submissionId,
      });
    } catch (caught) {
      // Client-provided submission ids stay recoverable for retries; server-minted
      // ones are cleaned up so empty plain posts do not leave orphan sessions.
      if (!submittedId) {
        try {
          await archiveManagedSessionForHub(session.sessionId);
        } catch {
          // Preserve the queueing failure. The session remains recoverable in the registry if
          // best-effort cleanup itself fails.
        }
      }
      const error = caught instanceof Error ? caught.message : t.assignFailed;
      return fail(400, {
        intent: "startConversation",
        success: false,
        error,
        message: error,
        values,
      });
    }

    const sessionsPath = workbenchSessionsPathFromPathname(url?.pathname ?? "") ?? "/sessions";
    redirect(303, `${sessionsPath}/${encodeURIComponent(session.sessionId)}`);
  },

  sendMessage: async ({ cookies, params, request }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const message = formText(formData, "message").trim();
    const submissionId = formText(formData, "submissionId").trim() || createHubSubmissionId();
    const values = { sessionId, message, submissionId };
    let attachments;
    try {
      attachments = await turnAttachmentsFromFormData(formData);
    } catch (caught) {
      const error = turnAttachmentErrorMessage(caught, t.workbench);
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error,
        message: error,
        values,
      });
    }

    if (!sessionId) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignSessionRequired,
        message: t.assignSessionRequired,
        values,
      });
    }
    if (!message && attachments.length === 0) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignGoalRequired,
        message: t.assignGoalRequired,
        values,
      });
    }
    const slashActionError = message
      ? hubSlashSubmissionError(message, t.workbench.slashActions)
      : null;
    if (slashActionError) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: slashActionError,
        message: slashActionError,
        values,
      });
    }

    // Sending must not wait for a redundant live `session.get` command. The
    // selected conversation is already projected locally, while `turn.submit`
    // is the daemon-owned admission boundary that validates current state and
    // durably deduplicates the browser submission nonce.
    let session;
    try {
      session = getProjectedManagedSessionForHub(sessionId);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.assignFailed;
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error,
        message: error,
        values,
      });
    }
    if (!session) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignSessionRequired,
        message: t.assignSessionRequired,
        values,
      });
    }
    const workspaceId = workspaceIdForWorkbenchSession(session);
    if (!workspaceId) {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignSessionRequired,
        message: t.assignSessionRequired,
        values,
      });
    }
    assertRouteWorkspace(params, workspaceId, "Session not found.");
    if (session.placement === "archived") {
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error: t.assignArchived,
        message: t.assignArchived,
        values,
      });
    }

    try {
      const prompt = attachmentPrompt(message, attachments, {
        image: t.workbench.attachmentImage,
        file: t.workbench.attachmentFile,
      });
      const turn = await submitConversationMessage({
        workspaceId,
        sessionId,
        message: prompt,
        attachments,
        submissionId,
      });

      return {
        intent: "sendMessage",
        success: true,
        message: t.assignQueued,
        queuedTurnId: turn.turnId,
        values: { sessionId, message: "", submissionId: createHubSubmissionId() },
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.assignFailed;
      return fail(400, {
        intent: "sendMessage",
        success: false,
        error,
        message: error,
        values,
      });
    }
  },

  cancelTurn: async ({ cookies, params, request }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const turnId = formText(formData, "turnId").trim();
    const dequeue = formText(formData, "cancelIntent").trim() === "dequeue";
    const intent = dequeue ? "removeQueuedTurn" : "cancelTurn";
    const values = { sessionId, turnId };

    if (!sessionId) {
      return fail(400, {
        intent,
        success: false,
        error: t.cancelSessionRequired,
        message: t.cancelSessionRequired,
        values,
      });
    }
    if (!turnId) {
      return fail(400, {
        intent,
        success: false,
        error: t.cancelTurnRequired,
        message: t.cancelTurnRequired,
        values,
      });
    }

    // Cancel must not wait for a live `session.get`. Workspace admission uses
    // the local projection; `turn.cancel` remains the daemon-owned gate.
    let session;
    try {
      session = getProjectedManagedSessionForHub(sessionId);
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.cancelTurnFailed;
      return fail(400, {
        intent,
        success: false,
        error,
        message: error,
        values,
      });
    }
    if (!session) {
      return fail(400, {
        intent,
        success: false,
        error: t.cancelSessionRequired,
        message: t.cancelSessionRequired,
        values,
      });
    }
    const workspaceId = workspaceIdForWorkbenchSession(session);
    if (!workspaceId) {
      return fail(400, {
        intent,
        success: false,
        error: t.cancelSessionRequired,
        message: t.cancelSessionRequired,
        values,
      });
    }
    assertRouteWorkspace(params, workspaceId, "Session not found.");
    if (session.placement === "archived") {
      return fail(400, {
        intent,
        success: false,
        error: t.cancelTurnArchived,
        message: t.cancelTurnArchived,
        values,
      });
    }

    try {
      const result = await cancelConversationTurnForHub({ sessionId, turnId });
      if (!result.cancelRequested && result.status !== "cancelled") {
        // Stop is idempotent at the conversation surface. If daemon truth has
        // already converged, silently accept the stale click and let the page
        // refresh clear its optimistic run state.
        return {
          intent,
          success: true,
          cancelled: false,
          converged: true,
          invocationStatus: result.status,
          cancelledTurnId: result.turnId,
          values,
        };
      }
      return {
        intent,
        success: true,
        cancelled: true,
        message:
          dequeue && result.status === "cancelled" ? t.cancelTurnDequeued : t.cancelTurnSucceeded,
        invocationStatus: result.status,
        cancelledTurnId: result.turnId,
        values: { sessionId, turnId: result.turnId },
      };
    } catch (caught) {
      const error = caught instanceof Error ? caught.message : t.cancelTurnFailed;
      return fail(400, {
        intent,
        success: false,
        cancelled: false,
        error,
        message: error,
        values,
      });
    }
  },

  selectModel: async ({ cookies, params, request }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const model = formText(formData, "model").trim();
    if (!sessionId || !model) {
      return fail(400, {
        intent: "selectModel",
        success: false,
        message: t.selectModelRequired,
      });
    }
    try {
      const session = await getManagedSessionForHub(sessionId);
      const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
      if (!session || !workspaceId) {
        return fail(400, {
          intent: "selectModel",
          success: false,
          message: t.selectModelRequired,
          values: { sessionId, model },
        });
      }
      assertRouteWorkspace(params, workspaceId, "Session not found.");
      const updatedSession = await setSessionModelForHub(sessionId, parseModelValue(model));
      if (!updatedSession.model) {
        return fail(400, {
          intent: "selectModel",
          success: false,
          message: t.effectiveModelMissing,
          values: { sessionId, model },
        });
      }
      const effectiveModel = modelValue(updatedSession.model);
      return {
        intent: "selectModel",
        success: true,
        message: t.workbench.modelUpdated,
        model: effectiveModel,
        values: { sessionId, model: effectiveModel },
      };
    } catch {
      return fail(400, {
        intent: "selectModel",
        success: false,
        message: t.workbench.modelFailed,
        values: { sessionId, model },
      });
    }
  },

  selectThinking: async ({ cookies, params, request }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const thinkingLevel = formText(formData, "thinkingLevel").trim();
    if (!sessionId || !thinkingLevel) {
      return fail(400, {
        intent: "selectThinking",
        success: false,
        message: t.selectThinkingRequired,
      });
    }
    try {
      const session = await getManagedSessionForHub(sessionId);
      const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
      if (!session || !workspaceId) {
        return fail(400, {
          intent: "selectThinking",
          success: false,
          message: t.selectThinkingRequired,
          values: { sessionId, thinkingLevel },
        });
      }
      assertRouteWorkspace(params, workspaceId, "Session not found.");
      const updatedSession = await setSessionThinkingLevelForHub(
        sessionId,
        parseThinkingLevelValue(thinkingLevel),
      );
      const level = updatedSession.thinkingLevel ?? thinkingLevel;
      return {
        intent: "selectThinking",
        success: true,
        message: t.workbench.thinkingUpdated,
        thinkingLevel: level,
        values: { sessionId, thinkingLevel: level },
      };
    } catch {
      return fail(400, {
        intent: "selectThinking",
        success: false,
        message: t.workbench.thinkingFailed,
        values: { sessionId, thinkingLevel },
      });
    }
  },

  selectMode: async ({ cookies, params, request }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();
    const parsedMode = sparkSessionModeSchema.safeParse(formText(formData, "mode").trim());
    if (!sessionId || !parsedMode.success) {
      return fail(400, {
        intent: "selectMode",
        success: false,
        message: t.selectModeRequired,
      });
    }
    const mode = parsedMode.data;
    try {
      const session = await getManagedSessionForHub(sessionId);
      const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
      if (!session || !workspaceId) {
        return fail(400, {
          intent: "selectMode",
          success: false,
          message: t.selectModeRequired,
          values: { sessionId, mode },
        });
      }
      assertRouteWorkspace(params, workspaceId, "Session not found.");
      const result = await setManagedSessionModeForHub({ sessionId, mode });
      return {
        intent: "selectMode",
        success: true,
        message: t.workbench.modeUpdated,
        mode: result.mode,
        values: { sessionId, mode: result.mode },
      };
    } catch {
      return fail(400, {
        intent: "selectMode",
        success: false,
        message: t.workbench.modeFailed,
        values: { sessionId, mode },
      });
    }
  },

  archiveSession: async ({ cookies, params, request, url }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();

    if (!sessionId) {
      return fail(400, {
        intent: "archiveSession",
        message: t.archiveSessionRequired,
      });
    }

    try {
      const session = await getManagedSessionForHub(sessionId);
      const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
      if (!session || !workspaceId) {
        return fail(400, {
          intent: "archiveSession",
          message: t.archiveSessionRequired,
        });
      }
      assertRouteWorkspace(params, workspaceId, "Session not found.");
      if (sessionHasChannelBinding(session)) {
        return fail(409, {
          intent: "archiveSession",
          message: t.archiveChannelBound,
        });
      }
      await archiveManagedSessionForHub(sessionId);
    } catch (caught) {
      return fail(400, {
        intent: "archiveSession",
        message: caught instanceof Error ? caught.message : t.archiveFailed,
      });
    }

    redirect(303, workbenchSessionsPathFromPathname(url?.pathname ?? "") ?? "/sessions");
  },

  closeSession: async ({ cookies, params, request, url }: SessionActionEvent) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).sessions;
    const formData = await request.formData();
    const sessionId = formText(formData, "sessionId").trim();

    if (!sessionId) {
      return fail(400, {
        intent: "closeSession",
        message: t.closeSessionRequired,
      });
    }

    try {
      const session = await getManagedSessionForHub(sessionId);
      const workspaceId = session ? workspaceIdForWorkbenchSession(session) : null;
      if (!session || !workspaceId) {
        return fail(400, {
          intent: "closeSession",
          message: t.closeSessionRequired,
        });
      }
      assertRouteWorkspace(params, workspaceId, "Session not found.");
      await closeManagedSessionForHub(sessionId);
    } catch (caught) {
      return fail(400, {
        intent: "closeSession",
        message: caught instanceof Error ? caught.message : t.closeFailed,
      });
    }

    redirect(303, workbenchSessionsPathFromPathname(url?.pathname ?? "") ?? "/sessions");
  },
} satisfies Actions;

function assertRouteWorkspace(
  params: Record<string, string | undefined> | undefined,
  actualWorkspaceId: string,
  message: string,
): void {
  const routeWorkspaceId = params?.workspaceId?.trim();
  if (!routeWorkspaceId) return;
  const expectedWorkspace = requireWorkspaceByRouteId(getDatabase(), routeWorkspaceId);
  if (expectedWorkspace.id !== actualWorkspaceId) {
    throw httpError(404, message);
  }
}

async function submitConversationMessage(input: {
  workspaceId?: string;
  sessionId: string;
  message: string;
  submissionId?: string;
  attachments?: import("@zendev-lab/spark-protocol").SparkTurnAttachment[];
}) {
  const title = titleFromPrompt(input.message);
  return await submitConversationTurnForHub({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    prompt: input.message,
    title,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.submissionId ? { submissionId: input.submissionId } : {}),
  });
}

function turnAttachmentErrorMessage(
  caught: unknown,
  copy: {
    attachmentCountError: string;
    attachmentSizeError: string;
    attachmentTotalSizeError: string;
  },
): string {
  if (!(caught instanceof TurnAttachmentValidationError)) return copy.attachmentTotalSizeError;
  if (caught.code === "count") return copy.attachmentCountError;
  if (caught.code === "file_size") {
    return copy.attachmentSizeError.replace("{name}", caught.fileName ?? "attachment");
  }
  return copy.attachmentTotalSizeError;
}
