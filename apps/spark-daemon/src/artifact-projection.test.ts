import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultArtifactStore, projectArtifact } from "@zendev-lab/spark-artifacts";
import {
  artifactProjectionEnvelopeSchema,
  createId,
  parseSparkDaemonEvent,
} from "@zendev-lab/spark-protocol";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { describe, expect, it } from "vitest";

import { runtimeEnvelopeForInvocationEvent } from "./daemon.ts";
import {
  ArtifactProjectionReconciler,
  artifactProjectionIdForRef,
  artifactDaemonProjectionEventFromToolResult,
} from "./artifact-projection.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { openSparkDaemonDatabase } from "./store/schema.ts";
import { registerWorkspace } from "./store/workspaces.ts";

describe("Artifact daemon projection", () => {
  it("scopes wire identity by workspace while preserving stable refs", () => {
    const ref = "artifact:preview:shared";
    const firstWorkspace = createId("ws");
    const secondWorkspace = createId("ws");

    expect(artifactProjectionIdForRef(firstWorkspace, ref)).toBe(
      artifactProjectionIdForRef(firstWorkspace, ref),
    );
    expect(artifactProjectionIdForRef(firstWorkspace, ref)).not.toBe(
      artifactProjectionIdForRef(secondWorkspace, ref),
    );
  });

  it("maps a changed artifact tool result through the durable daemon event and wire contract", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-daemon-artifact-"));
    try {
      const artifact = await createPreview(cwd, "# Durable");
      const workspaceId = createId("ws");
      const projectId = createId("proj");
      const invocationId = createId("inv");
      const workspaceBindingId = createId("rtwb");
      const event = artifactDaemonProjectionEventFromToolResult(
        {
          type: "tool_result",
          message: {
            toolName: "artifact",
            isError: false,
            details: {
              tool: "artifact",
              changed: true,
              artifact: { ...artifact, projection: projectArtifact(artifact) },
            },
          },
        },
        {
          workspaceId,
          projectId,
          sessionId: "session_demo",
          invocationId,
          metadata: { workspaceBindingId },
        },
      );

      expect(event).not.toBeNull();
      const persisted = parseSparkDaemonEvent(event);
      expect(persisted.type).toBe("daemon.artifact.projected");
      if (persisted.type !== "daemon.artifact.projected") return;
      const paths = resolveSparkPaths({
        app: "daemon",
        env: { HOME: cwd },
        overrides: {
          dataDir: join(cwd, "daemon-data"),
          cacheDir: join(cwd, "daemon-cache"),
          stateDir: join(cwd, "daemon-state"),
          runtimeDir: join(cwd, "daemon-run"),
        },
      });
      const db = openSparkDaemonDatabase(paths);
      const runtimeId = createId("rt");
      try {
        const workspace = registerWorkspace(db, {
          serverUrl: "https://hub.example.test/",
          serverWorkspaceId: workspaceId,
          serverBindingId: workspaceBindingId,
          localWorkspaceKey: "artifact-test",
          localPath: cwd,
        });
        const store = new SparkInvocationStore(db);
        store.submit({
          invocationId,
          workspaceBindingId,
          sessionId: "session_demo",
          prompt: "persist Artifact",
        });
        store.appendEvent(
          invocationId,
          persisted.type,
          persisted as unknown as Record<string, unknown>,
        );
        const pending = store.pendingDeliveries("hub:test", 1, [
          workspace.id,
          workspaceBindingId,
        ])[0];
        expect(pending).toBeDefined();
        const envelope = pending
          ? runtimeEnvelopeForInvocationEvent(pending, {
              store,
              db,
              runtimeId,
              serverUrl: "https://hub.example.test/",
            })
          : null;

        const parsed = artifactProjectionEnvelopeSchema.parse(envelope);
        expect(parsed.payload).toMatchObject({
          kind: "document",
          title: "Document",
          format: "markdown",
          contentRef: {
            artifactRef: artifact.ref,
            mediaType: "text/markdown",
            revision: 1,
            previewFormat: "md",
            inlineMarkdown: "# Durable",
          },
        });
      } finally {
        db.close();
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("ignores reads, failed calls, and malformed projections", () => {
    const context = { workspaceId: "ws_local" };
    const raw = {
      type: "tool_result",
      message: {
        toolName: "artifact",
        details: {
          tool: "artifact",
          changed: false,
          artifact: {
            ref: "artifact:preview:test",
            kind: "preview",
            title: "Preview",
            projection: {},
          },
        },
      },
    };

    expect(artifactDaemonProjectionEventFromToolResult(raw, context)).toBeNull();
    expect(
      artifactDaemonProjectionEventFromToolResult(
        {
          ...raw,
          message: {
            ...raw.message,
            isError: true,
            details: { ...raw.message.details, changed: true },
          },
        },
        context,
      ),
    ).toBeNull();
    expect(
      artifactDaemonProjectionEventFromToolResult(
        {
          ...raw,
          message: {
            ...raw.message,
            details: {
              ...raw.message.details,
              changed: true,
              artifact: {
                ref: "artifact:preview:test",
                kind: "preview",
                title: "Preview",
                projection: {
                  schemaVersion: 1,
                  format: "markdown",
                  mime: "text/markdown; charset=utf-8",
                  sizeBytes: 7,
                  hash: "0".repeat(64),
                  contentRef: {
                    artifactRef: "artifact:preview:other",
                    previewFormat: "md",
                    version: 1,
                    progress: null,
                    inlineMarkdown: "# Ready",
                  },
                },
              },
            },
          },
        },
        context,
      ),
    ).toBeNull();
  });

  it("replays on connect, suppresses acknowledged content, and emits a new revision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-daemon-product-reconcile-"));
    let now = 1_000;
    try {
      const store = defaultArtifactStore(cwd);
      const artifact = await createPreview(cwd, "# V1");
      const reconciler = new ArtifactProjectionReconciler({
        now: () => now,
        retryAfterMs: 100,
      });
      const target = {
        localPath: cwd,
        workspaceBindingId: "rtwb_demo",
        workspaceId: "ws_demo",
      };

      const first = await reconciler.collect(target);
      expect(first).toHaveLength(1);
      expect(first[0]?.payload.contentRef).toMatchObject({ inlineMarkdown: "# V1" });
      expect(await reconciler.collect(target)).toEqual([]);
      expect(reconciler.acknowledge(first[0]?.messageId ?? "")).toBe(true);
      now += 200;
      expect(await reconciler.collect(target)).toEqual([]);

      await store.update(artifact.ref, {
        body: {
          schemaVersion: 2,
          kind: "document",
          mediaType: "text/markdown",
          content: "# V2",
          revision: 2,
        },
      });
      const second = await reconciler.collect(target);
      expect(second).toHaveLength(1);
      expect(second[0]?.messageId).not.toBe(first[0]?.messageId);
      expect(second[0]?.payload.contentRef).toMatchObject({ inlineMarkdown: "# V2", version: 2 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function createPreview(cwd: string, content: string) {
  return defaultArtifactStore(cwd).put({
    ref: "artifact:preview:test",
    kind: "document",
    title: "Document",
    format: "markdown",
    body: {
      schemaVersion: 2,
      kind: "document",
      mediaType: "text/markdown",
      content,
      revision: 1,
    },
  });
}
