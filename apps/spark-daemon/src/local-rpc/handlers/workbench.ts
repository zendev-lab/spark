import { createHash } from "node:crypto";
import { join } from "node:path";

import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";
import type {
  SparkGlobalSearchResultEntry,
  SparkMessageView,
  SparkSessionExportFormat,
  SparkSessionSearchMatch,
  SparkSessionState,
  SparkSessionView,
} from "@zendev-lab/spark-protocol";
import { loadSparkSessionSnapshot, SparkSessionRegistryError } from "@zendev-lab/spark-session";

import { SparkDaemonControlError } from "../../control-error.ts";
import { requireSessionRegistry } from "../../session-control.ts";
import { SparkInvocationStore } from "../../store/invocations.ts";
import { listWorkspaces } from "../../store/workspaces.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type WorkbenchRequest = Extract<
  LocalRpcServiceRequest,
  { method: "search.global" | "session.search" | "session.export" }
>;

const maxCachedSessionExportBytes = 64 * 1024 * 1024;
const cachedSessionExportTtlMs = 5 * 60 * 1_000;

interface CachedSessionExport {
  revision: string;
  snapshot: Pick<SparkSessionView, "sessionId" | "title" | "messages">;
  bytes: number;
  lastAccessedAt: number;
}

const cachedSessionExports = new Map<string, CachedSessionExport>();
let cachedSessionExportBytes = 0;

export async function handleWorkbenchRequest(
  ctx: LocalRpcDispatchContext,
  request: WorkbenchRequest,
): Promise<LocalRpcServiceOutput<WorkbenchRequest>> {
  switch (request.method) {
    case "session.search":
      return await searchSession(ctx, request.params);
    case "search.global":
      return await searchGlobal(ctx, request.params);
    case "session.export":
      return await exportSession(ctx, request.params);
  }
}

async function searchSession(
  ctx: LocalRpcDispatchContext,
  input: { sessionId: string; query: string; limit: number },
) {
  const snapshot = await loadOwnedSessionSnapshot(ctx, input.sessionId);
  const query = input.query.toLocaleLowerCase();
  const matches: SparkSessionSearchMatch[] = [];
  let totalMatches = 0;
  for (const message of snapshot.messages.toReversed()) {
    const searchable = searchableMessageText(message);
    const index = searchable.toLocaleLowerCase().indexOf(query);
    if (index < 0) continue;
    totalMatches += 1;
    if (matches.length >= input.limit) continue;
    matches.push({
      ref: `message:${input.sessionId}:${message.id}`,
      sessionId: input.sessionId,
      messageId: message.id,
      role: message.role,
      excerpt: searchExcerpt(searchable, index, input.query.length),
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    });
  }
  return {
    sessionId: input.sessionId,
    query: input.query,
    matches,
    scannedMessages: snapshot.messages.length,
    totalMatches,
    truncated: totalMatches > matches.length,
    observedAt: new Date().toISOString(),
  };
}

async function searchGlobal(
  ctx: LocalRpcDispatchContext,
  input: { query: string; workspaceId?: string; includeArchived: boolean; limit: number },
) {
  const query = input.query.toLocaleLowerCase();
  const results: SparkGlobalSearchResultEntry[] = [];
  let totalMatches = 0;
  const push = (result: SparkGlobalSearchResultEntry) => {
    totalMatches += 1;
    if (results.length < input.limit) results.push(result);
  };
  const workspaces = listWorkspaces(ctx.db).filter(
    (workspace) => !input.workspaceId || workspace.id === input.workspaceId,
  );
  for (const workspace of workspaces) {
    if (
      `${workspace.displayName}\n${workspace.localWorkspaceKey}`.toLocaleLowerCase().includes(query)
    ) {
      push({
        kind: "workspace",
        ref: `workspace:${workspace.id}`,
        title: workspace.displayName,
        workspaceId: workspace.id,
        updatedAt: workspace.updatedAt,
      });
    }
    const artifacts = await defaultArtifactStore(workspace.localPath).list();
    for (const artifact of artifacts.toReversed()) {
      if (!`${artifact.title}\n${artifact.kind}`.toLocaleLowerCase().includes(query)) continue;
      push({
        kind: "artifact",
        ref: artifact.ref,
        title: artifact.title,
        summary: artifact.kind,
        workspaceId: workspace.id,
        updatedAt: artifact.updatedAt,
      });
    }
  }

  const registry = requireSessionRegistry(ctx.options);
  const sessions = await registry.list({
    includeArchived: input.includeArchived,
    ...(input.workspaceId
      ? { scope: { kind: "workspace" as const, workspaceId: input.workspaceId } }
      : {}),
  });
  for (const session of sessions) {
    if (session.lineage.kind === "root") continue;
    const workspaceId = session.scope.kind === "workspace" ? session.scope.workspaceId : undefined;
    const title = session.name?.trim() || session.sessionId;
    if (`${title}\n${session.sessionId}`.toLocaleLowerCase().includes(query)) {
      push({
        kind: "session",
        ref: `session:${session.sessionId}`,
        title,
        ...(workspaceId ? { workspaceId } : {}),
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
      });
    }
    const snapshot = await loadSessionSnapshot(ctx, session);
    for (const message of snapshot.messages.toReversed()) {
      const searchable = searchableMessageText(message);
      const index = searchable.toLocaleLowerCase().indexOf(query);
      if (index < 0) continue;
      push({
        kind: "message",
        ref: `message:${session.sessionId}:${message.id}`,
        title: title,
        summary: searchExcerpt(searchable, index, input.query.length),
        ...(workspaceId ? { workspaceId } : {}),
        sessionId: session.sessionId,
        messageId: message.id,
        ...((message.updatedAt ?? message.createdAt)
          ? { updatedAt: message.updatedAt ?? message.createdAt }
          : {}),
      });
    }
  }
  return {
    query: input.query,
    results,
    totalMatches,
    truncated: totalMatches > results.length,
    observedAt: new Date().toISOString(),
  };
}

async function exportSession(
  ctx: LocalRpcDispatchContext,
  input: {
    sessionId: string;
    format: SparkSessionExportFormat;
    offset: number;
    limit: number;
    revision?: string;
  },
) {
  pruneExpiredSessionExports(Date.now());
  const cachedKey = input.revision ? `${input.sessionId}:${input.revision}` : undefined;
  const cached = cachedKey ? cachedSessionExports.get(cachedKey) : undefined;
  const loaded = cached ? undefined : await loadOwnedSessionSnapshot(ctx, input.sessionId);
  const revision = cached
    ? cached.revision
    : createHash("sha256")
        .update(JSON.stringify({ title: loaded!.title, messages: loaded!.messages }))
        .digest("hex");
  if (input.revision && input.revision !== revision) {
    throw new SparkSessionRegistryError(
      "session_transcript_changed",
      "Session transcript changed while export pages were being read. Restart the export.",
    );
  }
  const snapshot = cached?.snapshot ?? loaded!;
  cacheSessionExport(input.sessionId, revision, snapshot);
  if (input.offset > snapshot.messages.length) {
    throw new SparkSessionRegistryError(
      "session_snapshot_cursor_not_found",
      `Session export offset ${input.offset} is outside the current transcript.`,
    );
  }
  const messages = snapshot.messages.slice(input.offset, input.offset + input.limit);
  const nextOffset = input.offset + messages.length;
  const complete = nextOffset >= snapshot.messages.length;
  const descriptor = exportDescriptor(input.format);
  return {
    sessionId: input.sessionId,
    format: input.format,
    revision,
    contentType: descriptor.contentType,
    filename: `spark-${safeFilenameSegment(input.sessionId)}.${descriptor.extension}`,
    offset: input.offset,
    ...(complete ? {} : { nextOffset }),
    totalMessages: snapshot.messages.length,
    chunk: formatExportChunk(snapshot, input.format, messages, input.offset, complete, revision),
    complete,
  };
}

async function loadOwnedSessionSnapshot(
  ctx: LocalRpcDispatchContext,
  sessionId: string,
): Promise<SparkSessionView> {
  const registry = requireSessionRegistry(ctx.options);
  const session = await registry.get(sessionId);
  if (!session || session.lineage.kind === "root") {
    throw new SparkSessionRegistryError("session_not_found", `Unknown Session: ${sessionId}`);
  }
  return await loadSessionSnapshot(ctx, session);
}

async function loadSessionSnapshot(
  ctx: LocalRpcDispatchContext,
  session: SparkSessionState,
): Promise<SparkSessionView> {
  if (!ctx.paths.sessionRuntimeDir) {
    throw new SparkDaemonControlError(
      "session_storage_unavailable",
      "Spark daemon native session storage is not available.",
    );
  }
  const activity = new SparkInvocationStore(ctx.db).sessionActivity(session.sessionId).activity;
  return await loadSparkSessionSnapshot({
    sessionsRoot: join(ctx.paths.sessionRuntimeDir, "sessions"),
    session,
    activity,
  });
}

function searchableMessageText(message: SparkMessageView): string {
  const partText = (message.parts ?? [])
    .flatMap((part) => {
      if (part.type === "text" || part.type === "thinking") return [part.text];
      if (part.type === "tool-call" || part.type === "tool-result") {
        return [part.toolName, part.summary ?? ""];
      }
      return [part.name ?? ""];
    })
    .filter(Boolean)
    .join("\n");
  return partText || message.text || "";
}

function searchExcerpt(text: string, matchIndex: number, queryLength: number): string {
  const start = Math.max(0, matchIndex - 180);
  const end = Math.min(text.length, matchIndex + queryLength + 260);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
    .replace(/\s+/gu, " ")
    .slice(0, 512);
}

function exportDescriptor(format: SparkSessionExportFormat) {
  switch (format) {
    case "jsonl":
      return { contentType: "application/x-ndjson; charset=utf-8", extension: "jsonl" };
    case "json":
      return { contentType: "application/json; charset=utf-8", extension: "json" };
    case "text":
      return { contentType: "text/plain; charset=utf-8", extension: "txt" };
    case "html":
      return { contentType: "text/html; charset=utf-8", extension: "html" };
  }
}

function formatExportChunk(
  snapshot: Pick<SparkSessionView, "sessionId" | "title" | "messages">,
  format: SparkSessionExportFormat,
  messages: SparkMessageView[],
  offset: number,
  complete: boolean,
  revision: string,
): string {
  switch (format) {
    case "jsonl": {
      const lines = messages.map((message) => JSON.stringify({ type: "message", message }));
      if (offset === 0) {
        lines.unshift(
          JSON.stringify({
            type: "session",
            sessionId: snapshot.sessionId,
            title: snapshot.title,
            revision,
          }),
        );
      }
      return lines.length > 0 ? `${lines.join("\n")}\n` : "";
    }
    case "json": {
      const prefix =
        offset === 0
          ? `${JSON.stringify({ sessionId: snapshot.sessionId, title: snapshot.title, revision }).slice(0, -1)},"messages":[`
          : messages.length > 0
            ? ","
            : "";
      return `${prefix}${messages.map((message) => JSON.stringify(message)).join(",")}${complete ? "]}\n" : ""}`;
    }
    case "text": {
      const prefix =
        offset === 0
          ? `Spark Session ${snapshot.title ?? snapshot.sessionId}\nSession: ${snapshot.sessionId}\nRevision: ${revision}\n`
          : "";
      return `${prefix}${messages.map(textMessage).join("")}`;
    }
    case "html": {
      const prefix =
        offset === 0
          ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(snapshot.title ?? snapshot.sessionId)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:900px;margin:auto;padding:2rem;color:#18212f;background:#fff}article{border-top:1px solid #d9dee7;padding:1rem 0}header{font-weight:700}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style></head><body><h1>${escapeHtml(snapshot.title ?? snapshot.sessionId)}</h1><p>Session ${escapeHtml(snapshot.sessionId)}</p>`
          : "";
      return `${prefix}${messages.map(htmlMessage).join("")}${complete ? "</body></html>\n" : ""}`;
    }
  }
}

function cacheSessionExport(
  sessionId: string,
  revision: string,
  snapshot: Pick<SparkSessionView, "sessionId" | "title" | "messages">,
): void {
  const now = Date.now();
  pruneExpiredSessionExports(now);

  const key = `${sessionId}:${revision}`;
  const existing = cachedSessionExports.get(key);
  if (existing) {
    existing.lastAccessedAt = now;
    cachedSessionExports.delete(key);
    cachedSessionExports.set(key, existing);
    return;
  }

  const exportSnapshot = {
    sessionId: snapshot.sessionId,
    title: snapshot.title,
    messages: snapshot.messages,
  };
  const bytes = Buffer.byteLength(JSON.stringify(exportSnapshot), "utf8");
  if (bytes > maxCachedSessionExportBytes) {
    throw new Error(
      `Session export exceeds the daemon's ${maxCachedSessionExportBytes} byte snapshot boundary.`,
    );
  }
  while (cachedSessionExportBytes + bytes > maxCachedSessionExportBytes) {
    const oldest = cachedSessionExports.entries().next().value as
      | [string, CachedSessionExport]
      | undefined;
    if (!oldest) break;
    cachedSessionExports.delete(oldest[0]);
    cachedSessionExportBytes -= oldest[1].bytes;
  }
  cachedSessionExports.set(key, {
    revision,
    snapshot: exportSnapshot,
    bytes,
    lastAccessedAt: now,
  });
  cachedSessionExportBytes += bytes;
}

function pruneExpiredSessionExports(now: number): void {
  for (const [key, entry] of cachedSessionExports) {
    if (now - entry.lastAccessedAt <= cachedSessionExportTtlMs) continue;
    cachedSessionExports.delete(key);
    cachedSessionExportBytes -= entry.bytes;
  }
}

function textMessage(message: SparkMessageView): string {
  return `\n[${message.role}${message.createdAt ? ` · ${message.createdAt}` : ""}]\n${searchableMessageText(message)}\n`;
}

function htmlMessage(message: SparkMessageView): string {
  const timestamp = message.createdAt ? ` <time>${escapeHtml(message.createdAt)}</time>` : "";
  return `<article data-message-id="${escapeHtml(message.id)}"><header>${escapeHtml(message.role)}${timestamp}</header><pre>${escapeHtml(searchableMessageText(message))}</pre></article>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeFilenameSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 180) || "session";
}
