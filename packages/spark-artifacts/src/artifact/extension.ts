import { Type } from "typebox";
import {
  type SparkHostAPI,
  type SparkHostContext,
  type ToolConfig,
} from "@zendev-lab/spark-invocation";
import { ToolCallText } from "@zendev-lab/spark-text-rendering";
import {
  isSparkDocumentMediaType,
  type SparkDocumentMediaType,
} from "@zendev-lab/spark-protocol/artifact-document";
import {
  ARTIFACT_KINDS,
  defaultArtifactStore,
  isArtifactBody,
  isArtifactKind,
  issueBodyFromSnapshot,
  parseForgeUrl,
  projectArtifact,
  syncForgeIssue,
  type Artifact,
  type ArtifactKind,
  type ArtifactProgress,
  type ArtifactRef,
  type DocumentArtifactBody,
} from "./index.ts";
import { syncDocumentArtifactFile } from "./file-sync.ts";
import { startTemporaryArtifactPreview } from "./preview-server.ts";

export interface PiArtifactsExtensionApi {
  registerTool(config: ToolConfig): void;
}

type ArtifactAction = "create" | "update" | "list" | "read" | "sync" | "sync_file" | "open_preview";

const ARTIFACT_KIND_DESCRIPTION =
  "issue (forge issue), git_change (one worktree plus its native PR stack), or document (typed content).";

const ARTIFACT_PROMPT_GUIDELINES = [
  "Artifact is for user-facing atomic work products. Internal verification uses evidence.",
  "Use git({ action }) to create or mutate git_change artifacts; artifact only reads them.",
  "Document format is content metadata, while preview is a view opened with action=open_preview.",
  "Sync issue state with action=sync. Sync an existing document from a cwd-local file with action=sync_file.",
  "Refresh or sync a git_change through git({ action: 'refresh' | 'sync' }).",
  ARTIFACT_KIND_DESCRIPTION,
];

export function registerArtifactTool(pi: PiArtifactsExtensionApi): void {
  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description: "Create, update, list, read, sync, sync files, or preview atomic Spark artifacts.",
    policy: artifactPolicy("local_write"),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      return action === "list" || action === "read"
        ? artifactPolicy("read")
        : artifactPolicy(action === "sync" ? "external_write" : "local_write");
    },
    promptGuidelines: ARTIFACT_PROMPT_GUIDELINES,
    parameters: Type.Object({
      action: Type.String({
        description: "create | update | list | read | sync | sync_file | open_preview",
      }),
      artifactRef: Type.Optional(
        Type.String({ description: "Artifact ref or unambiguous prefix (artifact:…)." }),
      ),
      kind: Type.Optional(
        Type.String({ description: `issue | git_change | document. ${ARTIFACT_KIND_DESCRIPTION}` }),
      ),
      title: Type.Optional(Type.String({ description: "Title for create/update." })),
      body: Type.Optional(Type.Any({ description: "Canonical typed body for update." })),
      url: Type.Optional(Type.String({ description: "Forge issue URL for create/sync." })),
      forge: Type.Optional(Type.String({ description: "github | gitlab" })),
      repo: Type.Optional(Type.String({ description: "owner/repo or GitLab path" })),
      number: Type.Optional(Type.Number({ description: "Issue number" })),
      content: Type.Optional(Type.String({ description: "Document content." })),
      sourcePath: Type.Optional(
        Type.String({ description: "cwd-local regular UTF-8 file for action=sync_file." }),
      ),
      mediaType: Type.Optional(Type.String({ description: "Document media type." })),
      format: Type.Optional(
        Type.String({
          description: "Document shorthand: md | mdx | html | a2ui.",
        }),
      ),
      updateMode: Type.Optional(
        Type.String({ description: "Document update mode: replace | append. Default replace." }),
      ),
      progress: Type.Optional(
        Type.Any({ description: "Document progress: { label?, percent?, stage? }" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max rows for list. Default 20." })),
    }),
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const target = typeof args.artifactRef === "string" ? args.artifactRef : undefined;
      const text = ["artifact", `action=${action}`, target].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requireCwd(ctx, "artifact");
      const store = defaultArtifactStore(cwd, ctx);
      const action = normalizeAction(params.action);

      if (action === "list") {
        const limit = normalizeLimit(params.limit, 20);
        const kind = normalizeOptionalKind(params.kind);
        const artifacts = await store.list({ kind });
        const newest = artifacts.toReversed().slice(0, limit);
        const lines = [
          `Artifacts: ${artifacts.length}${newest.length < artifacts.length ? ` (showing ${newest.length})` : ""}`,
          ...newest.map(renderListLine),
        ];
        if (newest.length === 0) lines.push("- No artifacts.");
        return toolResult(action, lines.join("\n"), {
          count: artifacts.length,
          artifacts: newest.map(compactSummary),
        });
      }

      if (action === "read" || action === "open_preview") {
        const artifact = await resolveArtifact(store, params.artifactRef);
        if (action === "read") {
          return toolResult(action, renderDetail(artifact), { artifact: compactDetail(artifact) });
        }
        if (artifact.body.kind !== "document") {
          throw new Error("open_preview requires a document artifact");
        }
        return openArtifactPreview(artifact as Artifact<DocumentArtifactBody>, ctx);
      }

      if (action === "create") {
        const created = await createArtifact(store, cwd, params);
        return toolResult(action, `Created ${created.ref} [${created.kind}] ${created.title}`, {
          changed: true,
          refs: { artifactRef: created.ref },
          artifact: compactDetail(created),
        });
      }

      if (action === "update") {
        const existing = await resolveArtifact(store, params.artifactRef);
        const updated = await updateArtifact(store, existing, params);
        return toolResult(action, `Updated ${updated.ref} [${updated.kind}] ${updated.title}`, {
          changed: true,
          refs: { artifactRef: updated.ref },
          artifact: compactDetail(updated),
        });
      }

      if (action === "sync_file") {
        const result = await syncFileArtifact(store, cwd, params);
        return toolResult(
          action,
          `${result.changed ? "Synced" : "Unchanged"} ${result.artifact.ref} [document] ${result.artifact.title}`,
          {
            changed: result.changed,
            refs: { artifactRef: result.artifact.ref },
            artifact: compactDetail(result.artifact),
          },
        );
      }

      const synced = await syncArtifact(store, cwd, params);
      return toolResult(action, `Synced ${synced.ref} [${synced.kind}] ${synced.title}`, {
        changed: true,
        refs: { artifactRef: synced.ref },
        artifact: compactDetail(synced),
      });
    },
  });
}

function artifactPolicy(effect: "read" | "local_write" | "external_write") {
  return {
    effect,
    executionMode: effect === "read" ? ("parallel" as const) : ("sequential" as const),
    domains: ["artifact"],
    approval: "none" as const,
  };
}

export function registerSparkArtifactTools(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("spark-artifacts artifact tool requires registerTool");
  registerArtifactTool({ registerTool: (config) => pi.registerTool?.(config) });
}

export { ARTIFACT_SYNC_FILE_MAX_BYTES } from "./file-sync.ts";

async function openArtifactPreview(
  artifact: Artifact<DocumentArtifactBody>,
  ctx: SparkHostContext,
) {
  const previewBase = {
    artifactRef: artifact.ref,
    title: artifact.title,
    mediaType: artifact.body.mediaType,
  };
  if (artifact.body.mediaType === "text/markdown" && ctx.sessionSource === "tui") {
    return toolResult("open_preview", artifact.body.content, {
      artifact: compactDetail(artifact),
      preview: { ...previewBase, target: "tui", supported: true },
    });
  }

  const hubCapable =
    ctx.sessionSource === "web" ||
    (ctx.hasUI === true && ctx.sessionSource !== "tui" && ctx.sessionSurface !== "channel");
  if (!hubCapable) {
    const message = "Document preview requires an attached local TUI or Hub surface.";
    return toolResult("open_preview", message, {
      artifact: compactDetail(artifact),
      preview: { ...previewBase, target: "unsupported", supported: false, reason: message },
    });
  }

  const opened = await startTemporaryArtifactPreview(artifact);
  return toolResult("open_preview", `Preview ready: ${opened.url}\nExpires: ${opened.expiresAt}`, {
    artifact: { ...compactDetail(artifact), preview: opened.url },
    preview: {
      ...previewBase,
      target: "browser",
      supported: true,
      url: opened.url,
      expiresAt: opened.expiresAt,
    },
  });
}

async function createArtifact(
  store: ReturnType<typeof defaultArtifactStore>,
  cwd: string,
  params: Record<string, unknown>,
): Promise<Artifact> {
  const kind = normalizeKind(params.kind, "kind");
  if (kind === "git_change") {
    throw new Error(
      "git_change lifecycle is managed by git({ action: 'init' | 'checkout' | 'adopt' })",
    );
  }
  if (kind === "document") {
    const body: DocumentArtifactBody = {
      schemaVersion: 2,
      kind: "document",
      mediaType: normalizeMediaType(params.mediaType, params.format),
      content: typeof params.content === "string" ? params.content : "",
      revision: 1,
      progress: normalizeProgress(params.progress),
    };
    return store.put({
      kind,
      title: normalizeRequiredString(params.title ?? "Document", "title"),
      body,
    });
  }

  const fromUrl = typeof params.url === "string" ? parseForgeUrl(params.url) : undefined;
  if (fromUrl?.kind === "pr") {
    throw new Error("PR URLs belong to git_change; use git({ action: 'checkout' | 'adopt' })");
  }
  const snapshot = await syncForgeIssue({
    cwd,
    forge: normalizeForge(params.forge ?? fromUrl?.forge),
    repo:
      typeof params.repo === "string" && params.repo.trim() ? params.repo.trim() : fromUrl?.repo,
    number: normalizePositiveInt(params.number ?? fromUrl?.number, "number"),
  });
  const body = issueBodyFromSnapshot(snapshot);
  return store.put({
    kind,
    title: normalizeRequiredString(params.title ?? body.title, "title"),
    format: "json",
    body,
  });
}

async function updateArtifact(
  store: ReturnType<typeof defaultArtifactStore>,
  existing: Artifact,
  params: Record<string, unknown>,
): Promise<Artifact> {
  if (existing.body.kind === "git_change") {
    throw new Error("git_change mutations must use git({ action })");
  }
  if (existing.body.kind === "document") {
    const explicitlyConvertsMediaType =
      params.mediaType !== undefined || params.format !== undefined;
    if (!isSparkDocumentMediaType(existing.body.mediaType) && !explicitlyConvertsMediaType) {
      throw retiredDocumentUpdateError(existing.body.mediaType);
    }
    const mode = params.updateMode === "append" ? "append" : "replace";
    const nextContent =
      typeof params.content === "string"
        ? mode === "append"
          ? `${existing.body.content}${params.content}`
          : params.content
        : existing.body.content;
    const body: DocumentArtifactBody = {
      ...existing.body,
      mediaType:
        params.mediaType !== undefined || params.format !== undefined
          ? normalizeMediaType(params.mediaType, params.format)
          : existing.body.mediaType,
      content: nextContent,
      revision: existing.body.revision + 1,
      progress: normalizeProgress(params.progress) ?? existing.body.progress,
    };
    return store.update(existing.ref, {
      title: typeof params.title === "string" ? params.title : existing.title,
      body,
    });
  }

  if (params.body !== undefined) {
    if (!isArtifactBody(params.body) || params.body.kind !== "issue") {
      throw new Error("body must be a canonical issue body");
    }
    return store.update(existing.ref, {
      title: typeof params.title === "string" ? params.title : existing.title,
      body: params.body,
    });
  }
  if (typeof params.title === "string") {
    return store.update(existing.ref, { title: params.title });
  }
  throw new Error("update requires document content/progress, a canonical body, or title");
}

async function syncFileArtifact(
  store: ReturnType<typeof defaultArtifactStore>,
  cwd: string,
  params: Record<string, unknown>,
): Promise<{ artifact: Artifact<DocumentArtifactBody>; changed: boolean }> {
  const existing = await resolveArtifact(store, params.artifactRef);
  if (existing.body.kind !== "document") {
    throw new Error("sync_file requires a document artifact");
  }
  const explicitlyConvertsMediaType = params.mediaType !== undefined || params.format !== undefined;
  if (!isSparkDocumentMediaType(existing.body.mediaType) && !explicitlyConvertsMediaType) {
    throw retiredDocumentUpdateError(existing.body.mediaType);
  }

  const mediaType = explicitlyConvertsMediaType
    ? normalizeMediaType(params.mediaType, params.format)
    : existing.body.mediaType;
  if (!isSparkDocumentMediaType(mediaType)) {
    throw retiredDocumentUpdateError(mediaType);
  }
  const result = await syncDocumentArtifactFile({
    cwd,
    sourcePath: normalizeRequiredString(params.sourcePath, "sourcePath"),
    artifactRef: existing.ref,
    title: existing.title,
    mediaType,
    ...(existing.body.progress ? { progress: existing.body.progress } : {}),
    store,
  });
  return { artifact: result.artifact, changed: result.changed };
}

async function syncArtifact(
  store: ReturnType<typeof defaultArtifactStore>,
  cwd: string,
  params: Record<string, unknown>,
): Promise<Artifact> {
  const requestedArtifactRef =
    typeof params.artifactRef === "string" && params.artifactRef.trim()
      ? params.artifactRef.trim()
      : undefined;
  if (!requestedArtifactRef) {
    return createArtifact(store, cwd, { ...params, kind: params.kind ?? "issue" });
  }
  const existing = await resolveArtifact(store, requestedArtifactRef);
  if (existing.body.kind === "git_change") {
    throw new Error("use git({ action: 'refresh' | 'sync' }) for git_change artifacts");
  }
  if (existing.body.kind === "document") {
    throw new Error("sync does not apply to document artifacts");
  }
  const snapshot = await syncForgeIssue({
    cwd,
    forge: existing.body.forge,
    repo: existing.body.repo,
    number: existing.body.number,
  });
  const body = issueBodyFromSnapshot(snapshot);
  return store.update(existing.ref, { title: body.title, body });
}

function renderDetail(artifact: Artifact): string {
  const lines = [
    `${artifact.ref} [${artifact.kind}] ${artifact.title}`,
    `format=${artifact.format} updated=${artifact.updatedAt}`,
    "",
  ];
  if (artifact.body.kind === "document") {
    lines.push(
      `revision=${artifact.body.revision} mediaType=${artifact.body.mediaType}`,
      artifact.body.progress
        ? `progress=${JSON.stringify(artifact.body.progress)}`
        : "progress=(none)",
      "",
      artifact.body.content,
    );
  } else {
    lines.push(JSON.stringify(artifact.body, null, 2));
  }
  return lines.join("\n");
}

function renderListLine(artifact: Artifact): string {
  if (artifact.body.kind === "document") {
    const progress = artifact.body.progress?.label ?? artifact.body.progress?.stage ?? "";
    return `- [document] ${artifact.ref}: ${artifact.title} r${artifact.body.revision}${progress ? ` (${progress})` : ""}`;
  }
  if (artifact.body.kind === "git_change") {
    return `- [git_change] ${artifact.ref}: ${artifact.title} layers=${artifact.body.stack.entries.length} lifecycle=${artifact.body.lifecycle}`;
  }
  return `- [issue] ${artifact.ref}: ${artifact.title} ${artifact.body.repo}#${artifact.body.number}`;
}

function compactDetail(artifact: Artifact): Record<string, unknown> {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    format: artifact.format,
    body: artifact.body,
    projection: projectArtifact(artifact),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function compactSummary(artifact: Artifact): Record<string, unknown> {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    updatedAt: artifact.updatedAt,
  };
}

function toolResult(
  action: ArtifactAction,
  text: string,
  details: Record<string, unknown> = {},
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text }],
    details: { tool: "artifact", action, ...details },
  };
}

function normalizeAction(value: unknown): ArtifactAction {
  if (
    value === "create" ||
    value === "update" ||
    value === "list" ||
    value === "read" ||
    value === "sync" ||
    value === "sync_file" ||
    value === "open_preview"
  ) {
    return value;
  }
  throw new Error(
    "artifact.action must be create, update, list, read, sync, sync_file, or open_preview",
  );
}

function normalizeKind(value: unknown, field: string): ArtifactKind {
  if (!isArtifactKind(value)) {
    throw new Error(
      `${field} must be one of: ${ARTIFACT_KINDS.join(", ")}; received: ${String(value)}`,
    );
  }
  return value;
}

function normalizeOptionalKind(value: unknown): ArtifactKind | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeKind(value, "kind");
}

function normalizeRef(value: unknown, field: string): ArtifactRef {
  if (typeof value !== "string" || !value.startsWith("artifact:") || value.length <= 9) {
    throw new Error(`${field} must be an artifact: ref`);
  }
  return value as ArtifactRef;
}

async function resolveArtifact(
  store: ReturnType<typeof defaultArtifactStore>,
  value: unknown,
): Promise<Artifact> {
  const requestedRef = normalizeRef(value, "artifactRef");
  const exact = await store.tryGet(requestedRef);
  if (exact) return exact;
  const matches = (await store.list()).filter((artifact) => artifact.ref.startsWith(requestedRef));
  if (matches.length === 0) throw new Error(`artifact not found: ${requestedRef}`);
  if (matches.length > 1) {
    throw new Error(
      `artifactRef is ambiguous: ${requestedRef} matches ${matches.length} artifacts`,
    );
  }
  return matches[0]!;
}

function normalizeRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizeLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return value;
}

function normalizePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeForge(value: unknown): "github" | "gitlab" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "github" || value === "gitlab") return value;
  throw new Error("forge must be github or gitlab");
}

function normalizeMediaType(mediaType: unknown, format: unknown): SparkDocumentMediaType {
  if (mediaType !== undefined) {
    if (typeof mediaType === "string" && isSparkDocumentMediaType(mediaType.trim())) {
      return mediaType.trim() as SparkDocumentMediaType;
    }
    throw new Error(
      "mediaType must be text/markdown, text/mdx, text/html, or application/vnd.a2ui+json",
    );
  }
  switch (format) {
    case undefined:
    case "md":
      return "text/markdown";
    case "mdx":
      return "text/mdx";
    case "html":
      return "text/html";
    case "a2ui":
      return "application/vnd.a2ui+json";
    default:
      throw new Error("format must be md, mdx, html, or a2ui");
  }
}

function retiredDocumentUpdateError(mediaType: string): Error {
  return new Error(
    `document media type is read-only: ${mediaType}; explicitly convert it to md, mdx, html, or a2ui`,
  );
}

function normalizeProgress(value: unknown): ArtifactProgress | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("progress must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.percent !== undefined &&
    (typeof record.percent !== "number" ||
      !Number.isFinite(record.percent) ||
      record.percent < 0 ||
      record.percent > 100)
  ) {
    throw new Error("progress.percent must be a number from 0 to 100");
  }
  return {
    label: typeof record.label === "string" ? record.label : undefined,
    percent: typeof record.percent === "number" ? record.percent : undefined,
    stage: typeof record.stage === "string" ? record.stage : undefined,
  };
}

function requireCwd(ctx: { cwd?: string } | undefined, tool: string): string {
  const cwd = ctx?.cwd;
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error(`${tool} requires ctx.cwd`);
  return cwd;
}
