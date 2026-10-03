import type { DatabaseSync } from "node:sqlite";

import { getRuntimeSessionProjection } from "@zendev-lab/spark-hub-coordination/runtime-session-control";
import {
  normalizeSparkA2uiDocument,
  type SparkSessionReproWorkView,
} from "@zendev-lab/spark-protocol";

export type HubReproWorkbenchBinding = NonNullable<SparkSessionReproWorkView["workbench"]>;

export type HubReproWorkbenchProjection =
  | { status: "absent" }
  | { status: "pending"; binding: HubReproWorkbenchBinding }
  | {
      status: "ready";
      binding: HubReproWorkbenchBinding;
      artifactId: string;
      content: string;
    };

export function loadProjectedReproWorkbench(
  db: DatabaseSync,
  sessionId: string,
): HubReproWorkbenchProjection {
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

function workbenchDocumentMatches(
  content: string,
  reproId: string,
  binding: HubReproWorkbenchBinding,
): boolean {
  const document = normalizeSparkA2uiDocument(content);
  const surface = document.surfaces.find(
    (candidate) => candidate.surfaceId === `spark-repro-${safeId(reproId)}` && !candidate.deleted,
  );
  if (!surface || !isRecord(surface.dataModel)) return false;
  const model = surface.dataModel;
  return (
    model.schema === "spark.repro.workbench/v2" &&
    model.reproId === reproId &&
    model.artifactRef === binding.artifactRef &&
    model.revision === binding.revision &&
    model.lifecycle === binding.lifecycle
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
