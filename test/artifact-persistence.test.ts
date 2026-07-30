import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultArtifactStore, projectArtifact, type Artifact } from "@zendev-lab/spark-artifacts";
import {
  createId,
  runtimeProtocolVersion,
  sparkArtifactProjectionSchema,
} from "@zendev-lab/spark-protocol";
import { describe, expect, it } from "vitest";

import { renderStoredArtifactPreview } from "../apps/spark-cockpit/src/lib/server/artifact-preview.ts";
import { artifactProjected } from "../apps/spark-daemon/src/protocol/outbound.ts";
import {
  artifactProjectionPayload,
  type ArtifactProjectionSource,
} from "../apps/spark-daemon/src/artifact-projection.ts";
import { migrate, openDatabase } from "../packages/spark-cockpit-db/src/index.ts";
import { readArtifactPreviewContent } from "../packages/spark-cockpit-coordination/src/artifact-cache.ts";
import {
  createProject,
  createWorkspaceWithLease,
} from "../packages/spark-cockpit-coordination/src/projection-services.ts";
import { attachRuntimeWebSocket } from "../packages/spark-cockpit-coordination/src/runtime-ws.ts";

class FakeRuntimeSocket extends EventEmitter {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.emit("close", code, Buffer.from(reason));
  }

  emitMessage(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
}

describe("Artifact persistent Cockpit preview", () => {
  it("survives Cockpit restart and replaces cached content on the next revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "spark-product-persistence-"));
    const databasePath = join(root, "cockpit.sqlite");
    const cacheRoot = join(root, "cache");
    const workspacePath = join(root, "workspace");
    const runtimeId = createId("rt");
    const workspaceBindingId = createId("rtwb");
    const now = "2026-07-28T00:00:00.000Z";
    let db = openDatabase({ path: databasePath });
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO runtime_connections
          (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
         VALUES (?, ?, ?, 'offline', ?, '{}', '{}', ?, ?)`,
      ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);

      let socket = connectRuntime({
        db,
        runtimeId,
        workspaceBindingId,
        workspacePath,
        now,
      });
      const workspace = createWorkspaceWithLease(db, {
        slug: "product-persistence",
        name: "Product persistence",
        runtimeWorkspaceBindingId: workspaceBindingId,
        createdAt: now,
      });
      const project = createProject(db, {
        workspaceId: workspace.id,
        slug: "persistent-preview",
        name: "Persistent preview",
        createdAt: now,
      });
      const invocationId = createId("inv");
      const store = defaultArtifactStore(workspacePath);
      const v1 = await store.put({
        ref: "artifact:preview:persistent",
        kind: "preview",
        title: "Persistent preview",
        format: "mdx",
        body: {
          schemaVersion: 1,
          kind: "preview",
          format: "mdx",
          content: '<Callout tone="success">Version one</Callout>',
          version: 1,
        },
      });
      const v1MessageId = createId("msg");
      sendProjection(socket, {
        runtimeId,
        workspaceBindingId,
        workspaceId: workspace.id,
        source: sourceFromArtifact(v1),
        messageId: v1MessageId,
        projectId: project.id,
        invocationId,
        sessionId: "session_persistent_preview",
      });

      const beforeRestart = db
        .prepare(
          `SELECT created_at AS createdAt, content_ref_json AS contentRefJson
           FROM artifacts
           WHERE id = ?`,
        )
        .get(
          artifactProjectionPayload(sourceFromArtifact(v1), {
            workspaceId: workspace.id,
          }).artifactId,
        ) as {
        createdAt: string;
        contentRefJson: string;
      };
      expect(
        socket.sent.some(
          (message) =>
            (JSON.parse(message) as { type?: string; ackOf?: string }).type ===
              "server.ingest_ack" &&
            (JSON.parse(message) as { ackOf?: string }).ackOf === v1MessageId,
        ),
      ).toBe(true);

      socket.close();
      db.close();
      db = openDatabase({ path: databasePath });
      migrate(db);

      const artifactId = artifactProjectionPayload(sourceFromArtifact(v1), {
        workspaceId: workspace.id,
      }).artifactId;
      const persisted = readArtifactPreviewContent(db, artifactId, { cacheRoot });
      expect(persisted.cache.previewStatus).toBe("ready");
      expect(persisted.body?.toString("utf8")).toContain("Version one");
      expect(
        renderStoredArtifactPreview({
          kind: "preview",
          title: "Persistent preview",
          contentRef: JSON.parse(beforeRestart.contentRefJson) as unknown,
          body: {
            text: persisted.body?.toString("utf8") ?? null,
            truncated: false,
          },
        }),
      ).toContain("Version one");

      const v2 = await store.update(v1.ref, {
        body: {
          schemaVersion: 1,
          kind: "preview",
          format: "mdx",
          content: '<Callout tone="warning">Version two</Callout>',
          version: 2,
        },
      });
      socket = connectRuntime({
        db,
        runtimeId,
        workspaceBindingId,
        workspacePath,
        now: "2026-07-28T00:01:00.000Z",
      });
      const v2MessageId = createId("msg");
      sendProjection(socket, {
        runtimeId,
        workspaceBindingId,
        workspaceId: workspace.id,
        source: sourceFromArtifact(v2),
        messageId: v2MessageId,
      });

      const updated = readArtifactPreviewContent(db, artifactId, { cacheRoot });
      expect(updated.body?.toString("utf8")).toContain("Version two");
      expect(updated.body?.toString("utf8")).not.toContain("Version one");
      sendProjection(socket, {
        runtimeId,
        workspaceBindingId,
        workspaceId: workspace.id,
        source: sourceFromArtifact(v1),
        messageId: createId("msg"),
      });
      const afterDelayedRevision = readArtifactPreviewContent(db, artifactId, { cacheRoot });
      expect(afterDelayedRevision.body?.toString("utf8")).toContain("Version two");
      expect(afterDelayedRevision.body?.toString("utf8")).not.toContain("Version one");
      const storedArtifact = db
        .prepare(
          `SELECT created_at AS createdAt,
                  updated_at AS updatedAt,
                  project_id AS projectId,
                  provenance_json AS provenanceJson
           FROM artifacts
           WHERE id = ?`,
        )
        .get(artifactId) as {
        createdAt: string;
        updatedAt: string;
        projectId: string | null;
        provenanceJson: string;
      };
      expect(storedArtifact).toMatchObject({
        createdAt: beforeRestart.createdAt,
        projectId: project.id,
      });
      expect(JSON.parse(storedArtifact.provenanceJson)).toMatchObject({
        runtimeInvocationId: invocationId,
        sessionId: "session_persistent_preview",
      });
      expect(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM artifact_links WHERE artifact_id = ?")
            .get(artifactId) as { count: number }
        ).count,
      ).toBe(3);
      socket.close();
    } finally {
      if (db.isOpen) db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function connectRuntime(input: {
  db: ReturnType<typeof openDatabase>;
  runtimeId: string;
  workspaceBindingId: string;
  workspacePath: string;
  now: string;
}): FakeRuntimeSocket {
  const socket = new FakeRuntimeSocket();
  attachRuntimeWebSocket(socket, {
    db: input.db,
    runtimeId: input.runtimeId,
    remoteAddress: "127.0.0.1",
  });
  socket.emitMessage({
    protocolVersion: runtimeProtocolVersion,
    messageId: createId("msg"),
    type: "runtime.hello",
    sentAt: input.now,
    payload: {
      runtimeId: input.runtimeId,
      runtimeVersion: "0.0.0-test",
      supportedFeatures: ["ws-control-v1", "artifact-ref-v1", "artifact-cache-upload-v1"],
      workspaceBindings: [
        {
          bindingId: input.workspaceBindingId,
          localWorkspaceKey: "product-persistence",
          localPath: input.workspacePath,
          displayName: "Product persistence",
          status: "available",
          capabilities: {},
          diagnostics: {},
        },
      ],
    },
  });
  return socket;
}

function sendProjection(
  socket: FakeRuntimeSocket,
  input: {
    runtimeId: string;
    workspaceBindingId: string;
    workspaceId: string;
    source: ArtifactProjectionSource;
    messageId: string;
    projectId?: string;
    invocationId?: string;
    sessionId?: string;
  },
): void {
  socket.emitMessage(
    artifactProjected(
      artifactProjectionPayload(input.source, {
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId, scope: "project" } : {}),
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      }),
      {
        runtimeId: input.runtimeId,
        workspaceBindingId: input.workspaceBindingId,
        workspaceId: input.workspaceId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      },
      { messageId: input.messageId },
    ),
  );
}

function sourceFromArtifact(artifact: Artifact): ArtifactProjectionSource {
  return {
    ref: artifact.ref,
    kind: artifact.kind,
    title: artifact.title,
    projection: sparkArtifactProjectionSchema.parse(projectArtifact(artifact)),
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}
