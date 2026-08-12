import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId, runtimeProtocolVersion } from "@zendev-lab/spark-protocol";
import { migrate, openMemoryDatabase } from "@zendev-lab/spark-hub-db";
import { createWorkspaceWithLease, recordArtifactProjection } from "./projection-services";
import {
  defaultArtifactCacheRoot,
  ensureArtifactPreviewCache,
  MAX_PREVIEW_BYTES,
  readArtifactPreviewContent,
} from "./artifact-cache";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function setupWorkspace() {
  const db = openMemoryDatabase();
  migrate(db);
  const now = "2026-05-22T00:00:00.000Z";
  const runtimeId = createId("rt");
  const runtimeWorkspaceBindingId = createId("rtwb");

  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, ?, ?, 'online', ?, '{}', '{}', ?, ?)`,
  ).run(runtimeId, "install-test", "Test runtime", runtimeProtocolVersion, now, now);

  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'local-default', 'Local default', 'available', '{}', '{}', ?, ?)`,
  ).run(runtimeWorkspaceBindingId, runtimeId, now, now);

  const workspace = createWorkspaceWithLease(db, {
    name: "Cache Workspace",
    slug: "cache-workspace",
    runtimeWorkspaceBindingId,
  });

  return { db, workspace, runtimeWorkspaceBindingId };
}

describe("artifact preview cache", () => {
  it("materializes inline text previews under the Hub cache root", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId: "artifact-inline",
          scope: "workspace",
          kind: "document",
          title: "Inline preview",
          format: "markdown",
          source: "runtime",
          contentRef: { inlineMarkdown: "# Hello\n" },
          provenance: { producer: "task" },
          links: [],
        },
      });

      const cache = ensureArtifactPreviewCache(db, "artifact-inline", { cacheRoot });
      expect(cache.previewStatus).toBe("ready");
      expect(readFileSync(cache.cachePath, "utf8")).toBe("# Hello\n");

      const result = readArtifactPreviewContent(db, "artifact-inline", { cacheRoot });
      expect(result.body?.toString("utf8")).toBe("# Hello\n");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("records oversized previews as explicit too_large states", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId: "artifact-large",
          scope: "workspace",
          kind: "document",
          title: "Large preview",
          format: "text",
          source: "runtime",
          contentRef: { inlineText: "x".repeat(MAX_PREVIEW_BYTES + 1) },
          provenance: { producer: "task" },
          links: [],
        },
      });

      const cache = ensureArtifactPreviewCache(db, "artifact-large", { cacheRoot });
      expect(cache.previewStatus).toBe("too_large");
      expect(cache.error?.reason).toBe("too_large");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("leaves external runtime pointers unmaterialized", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    const artifactId = "artifact-runtime-pointer";
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "document",
          title: "Runtime report",
          format: "markdown",
          source: "runtime",
          contentRef: { runtimePathRef: `artifact://runtime/${artifactId}.md` },
          provenance: { producer: "task" },
          links: [],
        },
      });

      const result = readArtifactPreviewContent(db, artifactId, { cacheRoot });

      expect(result.cache).toMatchObject({
        state: "missing",
        previewStatus: "missing",
        sourceRef: { runtimePathRef: `artifact://runtime/${artifactId}.md` },
      });
      expect(result.body).toBeUndefined();
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rejects binary previews without materializing a cache file", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    const artifactId = "artifact-binary";
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId,
          scope: "workspace",
          kind: "screenshot",
          title: "Diagram capture",
          format: "blob",
          source: "runtime",
          contentRef: { runtimePathRef: `artifact://runtime/${artifactId}.png` },
          provenance: { producer: "task" },
          links: [],
        },
      });

      const cache = ensureArtifactPreviewCache(db, artifactId, { cacheRoot });

      expect(cache).toMatchObject({
        state: "failed",
        previewStatus: "unsupported_binary",
        error: { reason: "unsupported_binary" },
      });
      expect(existsSync(cache.cachePath)).toBe(false);
    } finally {
      db.close();
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("replaces a cached preview when its content reference changes without a hash", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      const basePayload = {
        artifactId: "artifact-content-update",
        scope: "workspace" as const,
        kind: "document",
        title: "Updated preview",
        format: "markdown" as const,
        source: "runtime" as const,
        provenance: { producer: "task" },
        links: [],
      };
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: { ...basePayload, contentRef: { inlineMarkdown: "# First\n" } },
      });
      const first = ensureArtifactPreviewCache(db, basePayload.artifactId, {
        cacheRoot,
        now: "2026-05-22T00:01:00.000Z",
      });

      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: { ...basePayload, contentRef: { inlineMarkdown: "# Second\n" } },
      });
      const second = readArtifactPreviewContent(db, basePayload.artifactId, {
        cacheRoot,
        now: "2026-05-22T00:02:00.000Z",
      });

      expect(second.cache.id).toBe(first.id);
      expect(second.cache.sourceRef).toEqual({ inlineMarkdown: "# Second\n" });
      expect(second.body?.toString("utf8")).toBe("# Second\n");
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM artifact_cache_blobs WHERE artifact_id = ? AND state != 'evicted'",
            )
            .get(basePayload.artifactId) as { count: number }
        ).count,
      ).toBe(1);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("replaces a cached preview when its artifact hash changes", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      const basePayload = {
        artifactId: "artifact-hash-update",
        scope: "workspace" as const,
        kind: "document",
        title: "Hashed preview",
        format: "text" as const,
        source: "runtime" as const,
        contentRef: { inlineText: "canonical\n" },
        provenance: { producer: "task" },
        links: [],
      };
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: { ...basePayload, hash: "sha256:first" },
      });
      const first = ensureArtifactPreviewCache(db, basePayload.artifactId, { cacheRoot });
      writeFileSync(first.cachePath, "stale\n", "utf8");

      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: { ...basePayload, hash: "sha256:second" },
      });
      const second = readArtifactPreviewContent(db, basePayload.artifactId, { cacheRoot });

      expect(second.cache.id).toBe(first.id);
      expect(second.cache.hash).toBe("sha256:second");
      expect(second.body?.toString("utf8")).toBe("canonical\n");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it("rematerializes a ready inline preview when its cache file is missing", () => {
    const { db, workspace, runtimeWorkspaceBindingId } = setupWorkspace();
    const cacheRoot = mkdtempSync(join(tmpdir(), "spark-artifact-cache-"));
    try {
      recordArtifactProjection(db, {
        workspaceId: workspace.id,
        runtimeWorkspaceBindingId,
        payload: {
          artifactId: "artifact-missing-file",
          scope: "workspace",
          kind: "document",
          title: "Recoverable preview",
          format: "markdown",
          source: "runtime",
          contentRef: { inlineMarkdown: "# Restored\n" },
          provenance: { producer: "task" },
          links: [],
        },
      });
      const first = ensureArtifactPreviewCache(db, "artifact-missing-file", { cacheRoot });
      rmSync(first.cachePath);
      expect(existsSync(first.cachePath)).toBe(false);

      const recovered = readArtifactPreviewContent(db, "artifact-missing-file", {
        cacheRoot,
        now: "2026-05-22T00:03:00.000Z",
      });

      expect(recovered.cache.id).toBe(first.id);
      expect(recovered.cache.previewStatus).toBe("ready");
      expect(recovered.body?.toString("utf8")).toBe("# Restored\n");
      expect(existsSync(first.cachePath)).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});

describe("artifact preview cache paths", () => {
  it("uses the default XDG cache root", () => {
    process.env = { HOME: "/Users/example" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example", ".cache", "spark", "hub", "artifacts"),
    );
  });

  it("relocates the cache with SPARK_HOME", () => {
    process.env = { HOME: "/Users/example", SPARK_HOME: "/Users/example/spark-home" };

    expect(defaultArtifactCacheRoot()).toBe(
      join("/Users/example/spark-home", "apps", "hub", "cache", "artifacts"),
    );
  });
});
