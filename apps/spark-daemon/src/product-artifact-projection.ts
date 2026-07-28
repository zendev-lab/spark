import { createHash } from "node:crypto";
import {
  SPARK_PROTOCOL_VERSION,
  sparkArtifactProjectionSchema,
  type ArtifactProjectionPayload,
  type SparkArtifactProjection,
  type SparkDaemonEvent,
  type SparkJsonObject,
} from "@zendev-lab/spark-protocol";
import {
  defaultProductArtifactStore,
  projectProductArtifact,
  type ProductArtifact,
} from "@zendev-lab/spark-artifacts";

export const PRODUCT_ARTIFACT_KINDS = new Set(["issue", "pr", "preview"]);

export interface ProductArtifactProjectionSource {
  ref: string;
  kind: "issue" | "pr" | "preview";
  title: string;
  projection: SparkArtifactProjection;
  createdAt?: string;
  updatedAt?: string;
}

export interface ProductArtifactProjectionContext {
  workspaceId: string;
  scope?: "workspace" | "project";
  invocationId?: string;
  sessionId?: string;
  projectId?: string;
}

export interface ProductArtifactDaemonEventContext {
  workspaceId?: string;
  projectId?: string;
  invocationId?: string;
  sessionId?: string;
  metadata?: SparkJsonObject;
  emittedAt?: string;
}

export interface ProductArtifactProjectionReconcileTarget {
  localPath: string;
  workspaceBindingId: string;
  workspaceId: string;
}

export interface PendingProductArtifactProjection {
  messageId: string;
  workspaceBindingId: string;
  workspaceId: string;
  payload: ArtifactProjectionPayload;
}

interface ProductArtifactProjectionReconcileState {
  digest: string;
  messageId: string;
  acknowledged: boolean;
  lastSentAtMs: number;
}

export const PRODUCT_ARTIFACT_PROJECTION_RETRY_AFTER_MS = 30_000;
export const PRODUCT_ARTIFACT_PROJECTION_RECONCILE_INTERVAL_MS = 60_000;

/**
 * Runtime/Cockpit artifact ids use the protocol `art_` namespace. Product
 * Artifact refs remain the canonical workspace identity and are retained in
 * contentRef/provenance.
 */
export function artifactProjectionIdForRef(workspaceId: string, ref: string): `art_${string}` {
  return `art_${createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(ref)
    .digest("hex")
    .slice(0, 32)}`;
}

export function productArtifactProjectionPayload(
  artifact: ProductArtifactProjectionSource,
  context: ProductArtifactProjectionContext,
): ArtifactProjectionPayload {
  const projection = artifact.projection;
  const links = [
    ...(context.invocationId
      ? [
          {
            targetKind: "invocation",
            targetId: context.invocationId,
            relation: "produced-by",
          },
        ]
      : []),
    ...(context.sessionId
      ? [{ targetKind: "session", targetId: context.sessionId, relation: "visible-in" }]
      : []),
    ...(context.projectId
      ? [{ targetKind: "project", targetId: context.projectId, relation: "belongs-to" }]
      : []),
  ];

  return {
    artifactId: artifactProjectionIdForRef(context.workspaceId, artifact.ref),
    scope: context.scope ?? (context.projectId ? "project" : "workspace"),
    kind: artifact.kind,
    title: artifact.title,
    format: projection.format,
    source: "runtime",
    hash: projection.hash,
    sizeBytes: projection.sizeBytes,
    mime: projection.mime,
    contentRef: projection.contentRef,
    provenance: {
      producer: "spark-product-artifact",
      productArtifactRef: artifact.ref,
      projectionSchemaVersion: projection.schemaVersion,
      ...(artifact.createdAt ? { productArtifactCreatedAt: artifact.createdAt } : {}),
      ...(artifact.updatedAt ? { productArtifactUpdatedAt: artifact.updatedAt } : {}),
      ...(context.invocationId ? { runtimeInvocationId: context.invocationId } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    },
    links,
  };
}

export function productArtifactProjectionSourceFromToolResult(
  raw: unknown,
): ProductArtifactProjectionSource | null {
  if (!isRecord(raw) || raw.type !== "tool_result") return null;
  const message = isRecord(raw.message) ? raw.message : null;
  if (!message || message.toolName !== "artifact" || message.isError === true) return null;
  const details = isRecord(message.details) ? message.details : null;
  if (!details || details.tool !== "artifact" || details.changed !== true) return null;
  const artifact = details && isRecord(details.artifact) ? details.artifact : null;
  if (!artifact) return null;
  const ref = nonEmptyString(artifact.ref);
  const kind = nonEmptyString(artifact.kind);
  const title = nonEmptyString(artifact.title);
  const projection = sparkArtifactProjectionSchema.safeParse(artifact.projection);
  if (
    !ref?.startsWith("artifact:") ||
    !kind ||
    !PRODUCT_ARTIFACT_KINDS.has(kind) ||
    !title ||
    !projection.success
  ) {
    return null;
  }
  const createdAt = isoString(artifact.createdAt);
  const updatedAt = isoString(artifact.updatedAt);
  const contentRef = projection.data.contentRef;
  const hasPreviewShape = "previewFormat" in contentRef;
  if (contentRef.productArtifactRef !== ref || (kind === "preview") !== hasPreviewShape) {
    return null;
  }
  return {
    ref,
    kind: kind as ProductArtifactProjectionSource["kind"],
    title,
    projection: projection.data,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export function productArtifactDaemonProjectionEventFromToolResult(
  raw: unknown,
  context: ProductArtifactDaemonEventContext,
): SparkDaemonEvent | null {
  const artifact = productArtifactProjectionSourceFromToolResult(raw);
  if (!artifact) return null;
  return {
    version: SPARK_PROTOCOL_VERSION,
    type: "daemon.product_artifact.projected",
    source: "daemon",
    emittedAt: context.emittedAt ?? new Date().toISOString(),
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.projectId ? { projectId: context.projectId } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.invocationId ? { invocationId: context.invocationId } : {}),
    metadata: context.metadata ?? {},
    artifact,
  };
}

export async function listWorkspaceProductArtifactProjectionSources(
  localPath: string,
): Promise<ProductArtifactProjectionSource[]> {
  const artifacts = await defaultProductArtifactStore(localPath).list();
  return artifacts.map((artifact: ProductArtifact) => ({
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    projection: sparkArtifactProjectionSchema.parse(projectProductArtifact(artifact)),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  }));
}

/**
 * Connection-scoped change detector for canonical Product Artifacts. The
 * ProductArtifactStore remains the durable owner; this class only tracks wire
 * delivery and intentionally resets on reconnect so Cockpit can recover after
 * either side restarts.
 */
export class ProductArtifactProjectionReconciler {
  readonly #states = new Map<string, ProductArtifactProjectionReconcileState>();
  readonly #keyByMessageId = new Map<string, string>();
  readonly #now: () => number;
  readonly #retryAfterMs: number;

  constructor(options: { now?: () => number; retryAfterMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#retryAfterMs = options.retryAfterMs ?? PRODUCT_ARTIFACT_PROJECTION_RETRY_AFTER_MS;
  }

  async collect(
    target: ProductArtifactProjectionReconcileTarget,
  ): Promise<PendingProductArtifactProjection[]> {
    const sources = await listWorkspaceProductArtifactProjectionSources(target.localPath);
    const now = this.#now();
    const pending: PendingProductArtifactProjection[] = [];

    for (const source of sources) {
      const payload = productArtifactProjectionPayload(source, {
        workspaceId: target.workspaceId,
        scope: "workspace",
      });
      const key = `${target.workspaceBindingId}:${payload.artifactId}`;
      const digest = projectionDeliveryDigest(target, payload);
      let state = this.#states.get(key);
      if (!state || state.digest !== digest) {
        if (state) this.#keyByMessageId.delete(state.messageId);
        state = {
          digest,
          messageId: `msg_${digest.slice(0, 32)}`,
          acknowledged: false,
          lastSentAtMs: Number.NEGATIVE_INFINITY,
        };
        this.#states.set(key, state);
        this.#keyByMessageId.set(state.messageId, key);
      }
      if (state.acknowledged || now - state.lastSentAtMs < this.#retryAfterMs) continue;
      state.lastSentAtMs = now;
      pending.push({
        messageId: state.messageId,
        workspaceBindingId: target.workspaceBindingId,
        workspaceId: target.workspaceId,
        payload,
      });
    }

    return pending;
  }

  acknowledge(messageId: string): boolean {
    const key = this.#keyByMessageId.get(messageId);
    if (!key) return false;
    const state = this.#states.get(key);
    if (!state || state.messageId !== messageId) return false;
    state.acknowledged = true;
    return true;
  }

  markSendFailed(messageId: string): void {
    const key = this.#keyByMessageId.get(messageId);
    const state = key ? this.#states.get(key) : undefined;
    if (state?.messageId === messageId) {
      state.lastSentAtMs = Number.NEGATIVE_INFINITY;
    }
  }
}

function projectionDeliveryDigest(
  target: ProductArtifactProjectionReconcileTarget,
  payload: ArtifactProjectionPayload,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceBindingId: target.workspaceBindingId,
        workspaceId: target.workspaceId,
        payload,
      }),
    )
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isoString(value: unknown): string | undefined {
  const string = nonEmptyString(value);
  return string && !Number.isNaN(Date.parse(string)) ? string : undefined;
}
