import { createHash } from "node:crypto";
import {
  defaultArtifactStore,
  type Artifact,
  type ArtifactRef,
  type DocumentArtifactBody,
} from "@zendev-lab/spark-artifacts";
import { currentSparkReproCheckpoint, type SparkSessionRepro } from "@zendev-lab/spark-repro";
import type { DatabaseSync } from "node:sqlite";
import type { SparkDaemonWorkspace } from "./store/workspaces.ts";
import { SparkReproV10Store } from "./store/repro-v10.ts";

export async function projectDaemonSparkReproV10(input: {
  db: DatabaseSync;
  workspace: SparkDaemonWorkspace;
  repro: SparkSessionRepro;
}): Promise<void> {
  const terminal = ["complete", "stopped", "blocked"].includes(input.repro.status);
  const report = await putProjectionDocument({
    cwd: input.workspace.localPath,
    ref: projectionRef("report", input.repro.reproId),
    bindingId: `repro-report:${input.repro.reproId}`,
    title: `Repro report · ${input.repro.objective}`,
    mediaType: "text/markdown",
    content: () => renderReport(input.repro),
    seal: terminal,
    repro: input.repro,
  });
  const workbench = await putProjectionDocument({
    cwd: input.workspace.localPath,
    ref: projectionRef("workbench", input.repro.reproId),
    bindingId: `repro-workbench:${input.repro.reproId}`,
    title: `Repro Workbench · ${input.repro.objective}`,
    mediaType: "application/vnd.a2ui+json",
    content: (revision) => renderWorkbench(input.repro, revision, terminal ? "sealed" : "live"),
    seal: terminal,
    repro: input.repro,
  });
  new SparkReproV10Store(input.db).recordProjection({
    reproId: input.repro.reproId,
    stateUpdatedAt: input.repro.updatedAt,
    reportArtifactRef: report.ref,
    reportRevision: report.body.revision,
    workbenchArtifactRef: workbench.ref,
    workbenchRevision: workbench.body.revision,
    projectedAt: new Date().toISOString(),
  });
}

async function putProjectionDocument(input: {
  cwd: string;
  ref: ArtifactRef;
  bindingId: string;
  title: string;
  mediaType: DocumentArtifactBody["mediaType"];
  content: (revision: number) => string;
  seal: boolean;
  repro: SparkSessionRepro;
}): Promise<Artifact<DocumentArtifactBody>> {
  const store = defaultArtifactStore(input.cwd);
  const current = await store.tryGet<DocumentArtifactBody>(input.ref);
  if (current && current.body.kind !== "document") {
    throw new Error(`Repro projection ref is not a Document: ${input.ref}`);
  }
  const expectedRevision = current?.body.revision ?? null;
  const lifecycle = input.seal ? "sealed" : "live";
  if (
    current?.body.kind === "document" &&
    current.body.management?.bindingId === input.bindingId &&
    current.body.management.lifecycle === lifecycle &&
    current.body.mediaType === input.mediaType &&
    current.body.content === input.content(current.body.revision)
  ) {
    return current;
  }
  const nextRevision = expectedRevision === null ? 1 : expectedRevision + 1;
  const written = await store.putManagedDocument({
    ref: input.ref,
    bindingId: input.bindingId,
    title: input.title,
    mediaType: input.mediaType,
    content: input.content(nextRevision),
    expectedRevision,
    progress: projectionProgress(input.repro),
    seal: input.seal,
    reopen:
      current?.body.kind === "document" &&
      current.body.management?.lifecycle === "sealed" &&
      !input.seal,
  });
  return written.artifact;
}

function projectionProgress(repro: SparkSessionRepro): DocumentArtifactBody["progress"] {
  const accepted = repro.checkpoints.filter(
    (checkpoint) => checkpoint.status === "accepted",
  ).length;
  const checkpoint = currentSparkReproCheckpoint(repro);
  return {
    stage: checkpoint?.kind ?? repro.status,
    label: `${checkpoint?.kind ?? repro.status} · ${repro.status}`,
    percent: Math.round((accepted / 5) * 100),
  };
}

function renderReport(repro: SparkSessionRepro): string {
  const lines = [
    "# Spark Reproduction Report",
    "",
    `- Objective: ${repro.objective}`,
    `- Repro: \`${repro.reproId}\``,
    `- WorkItem: \`${repro.workItem.workItemId}\``,
    `- Status: \`${repro.status}\``,
    `- Checkpoints: ${repro.receipts.length}/5 accepted`,
    ...(repro.formalizedRevision ? [`- Formalized revision: \`${repro.formalizedRevision}\``] : []),
    ...(repro.blockingReason ? [`- Blocking reason: ${repro.blockingReason}`] : []),
    "",
    "## Checkpoints",
    "",
    ...repro.checkpoints.flatMap((checkpoint) => [
      `### ${checkpoint.kind}`,
      "",
      `- Lane Session: \`${checkpoint.sessionId}\``,
      `- Task: \`${checkpoint.taskRef}\``,
      `- Status: \`${checkpoint.status}\``,
      ...(checkpoint.runRef ? [`- TaskRun: \`${checkpoint.runRef}\``] : []),
      ...(checkpoint.summary ? [`- Summary: ${checkpoint.summary}`] : []),
      ...(checkpoint.evidenceRefs.length
        ? ["- Evidence:", ...checkpoint.evidenceRefs.map((ref) => `  - \`${ref}\``)]
        : []),
      "",
    ]),
  ];
  return lines.join("\n");
}

function renderWorkbench(
  repro: SparkSessionRepro,
  revision: number,
  lifecycle: "live" | "sealed",
): string {
  const checkpoint = currentSparkReproCheckpoint(repro);
  const surfaceId = `spark-repro-${safeId(repro.reproId)}`;
  return JSON.stringify({
    messages: [
      {
        version: "v0.9.1",
        createSurface: {
          surfaceId,
          catalogId: "https://a2ui.org/specification/v0_9_1/catalogs/basic/catalog.json",
        },
      },
      {
        version: "v0.9.1",
        updateComponents: {
          surfaceId,
          components: [
            { id: "root", component: "Column", children: ["title", "status", "checkpoint"] },
            { id: "title", component: "Text", variant: "h1", text: repro.objective },
            {
              id: "status",
              component: "Text",
              text: `${repro.status} · ${repro.receipts.length}/5 checkpoints accepted`,
            },
            {
              id: "checkpoint",
              component: "Text",
              text: checkpoint
                ? `${checkpoint.kind} · ${checkpoint.status} · ${checkpoint.sessionId}`
                : `formalized · ${repro.formalizedRevision ?? "no revision"}`,
            },
          ],
        },
      },
      {
        version: "v0.9.1",
        updateDataModel: {
          surfaceId,
          path: "/",
          value: {
            schema: "spark.repro.workbench/v2",
            reproId: repro.reproId,
            artifactRef: projectionRef("workbench", repro.reproId),
            revision,
            lifecycle,
            status: repro.status,
            checkpointId: checkpoint?.checkpointId ?? null,
          },
        },
      },
    ],
  });
}

function projectionRef(kind: "report" | "workbench", reproId: string): ArtifactRef {
  const suffix = createHash("sha256")
    .update(`spark.repro.${kind}/v10\0${reproId}`)
    .digest("hex")
    .slice(0, 32);
  return `artifact:repro-${kind}-${suffix}` as ArtifactRef;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "-");
}
