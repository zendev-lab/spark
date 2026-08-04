import type { DatabaseSync } from "node:sqlite";

import { getRuntimeSessionProjection } from "@zendev-lab/spark-cockpit-coordination/runtime-session-control";
import {
  normalizeSparkA2uiDocument,
  sparkWorkbenchActionRequestSchema,
  type SparkLoopMutationResult,
  type SparkSessionReproWorkView,
  type SparkWorkbenchActionRequest,
} from "@zendev-lab/spark-protocol";

import {
  createCockpitRuntimeSessionClient,
  type CockpitRuntimeSessionClient,
} from "./cockpit-runtime-session-client.ts";

export type CockpitReproWorkbenchBinding = NonNullable<SparkSessionReproWorkView["workbench"]>;

export type CockpitReproWorkbenchProjection =
  | { status: "absent" }
  | { status: "pending"; binding: CockpitReproWorkbenchBinding }
  | {
      status: "ready";
      binding: CockpitReproWorkbenchBinding;
      artifactId: string;
      content: string;
    };

export function loadProjectedReproWorkbench(
  db: DatabaseSync,
  sessionId: string,
): CockpitReproWorkbenchProjection {
  const projection = getRuntimeSessionProjection(db, sessionId);
  const snapshot = projection?.snapshot;
  const repro = snapshot?.work?.repro;
  const binding = repro?.workbench;
  if (!snapshot || snapshot.sessionId !== sessionId || !repro || !binding) {
    return { status: "absent" };
  }
  const row = db
    .prepare(
      `SELECT id, kind, hash,
              content_ref_json AS contentRefJson,
              provenance_json AS provenanceJson
       FROM artifacts
       WHERE workspace_id = ?
         AND json_valid(provenance_json)
         AND json_extract(provenance_json, '$.artifactRef') = ?
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .get(projection.workspaceId ?? "", binding.artifactRef) as
    | {
        id: string;
        kind: string;
        hash: string | null;
        contentRefJson: string;
        provenanceJson: string;
      }
    | undefined;
  if (!row) return { status: "pending", binding };

  const contentRef = parseRecord(row.contentRefJson);
  const provenance = parseRecord(row.provenanceJson);
  const content = contentRef?.inlineText;
  if (
    row.kind !== "document" ||
    !row.hash ||
    provenance?.artifactRef !== binding.artifactRef ||
    contentRef?.artifactRef !== binding.artifactRef ||
    contentRef.revision !== binding.revision ||
    contentRef.mediaType !== "application/vnd.a2ui+json" ||
    typeof content !== "string" ||
    !workbenchDocumentMatches(content, repro.reproId, binding)
  ) {
    return { status: "pending", binding };
  }
  return { status: "ready", binding, artifactId: row.id, content };
}

export async function controlReproWorkbenchForCockpit(
  input: { db: DatabaseSync; sessionId: string; action: unknown },
  client: Pick<
    CockpitRuntimeSessionClient,
    "controlWorkbench" | "snapshot"
  > = createCockpitRuntimeSessionClient(input.db),
): Promise<SparkLoopMutationResult> {
  const action = sparkWorkbenchActionRequestSchema.parse(input.action);
  const projected = loadProjectedReproWorkbench(input.db, input.sessionId);
  if (projected.status !== "ready" || projected.binding.lifecycle !== "live") {
    throw new ReproWorkbenchControlError(
      projected.status === "absent" ? "workbench_not_found" : "workbench_stale",
      "The trusted live Repro Workbench is unavailable or has changed.",
    );
  }
  const context = action.action.context;
  const binding = projected.binding;
  if (
    context.artifactRef !== binding.artifactRef ||
    context.revision !== binding.revision ||
    context.loopId !== binding.loopId ||
    context.generation !== binding.generation
  ) {
    throw new ReproWorkbenchControlError(
      "workbench_stale",
      "The Workbench action revision or Loop generation is stale.",
    );
  }
  const result = await client.controlWorkbench(input.sessionId, action);
  try {
    await client.snapshot(input.sessionId, { timeoutMs: 5_000 });
  } catch {
    // The mutation receipt is authoritative. Projection refresh can recover via SSE/reload.
  }
  return result;
}

export class ReproWorkbenchControlError extends Error {
  constructor(
    readonly code: "workbench_not_found" | "workbench_stale",
    message: string,
  ) {
    super(message);
    this.name = "ReproWorkbenchControlError";
  }
}

function workbenchDocumentMatches(
  content: string,
  reproId: string,
  binding: CockpitReproWorkbenchBinding,
): boolean {
  const document = normalizeSparkA2uiDocument(content);
  const surface = document.surfaces.find(
    (candidate) => candidate.surfaceId === `spark-repro-${safeId(reproId)}` && !candidate.deleted,
  );
  if (!surface || !isRecord(surface.dataModel)) return false;
  const model = surface.dataModel;
  return (
    model.schema === "spark.repro.workbench/v1" &&
    model.reproId === reproId &&
    model.artifactRef === binding.artifactRef &&
    model.revision === binding.revision &&
    model.lifecycle === binding.lifecycle &&
    model.loopId === binding.loopId &&
    model.generation === binding.generation
  );
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}

export type { SparkWorkbenchActionRequest };
