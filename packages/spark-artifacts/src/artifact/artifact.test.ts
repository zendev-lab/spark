import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolConfig } from "@zendev-lab/spark-core";
import { describe, expect, it } from "vitest";
import { defaultEvidenceStore, type EvidenceRef } from "../index.ts";
import { registerArtifactTool } from "./extension.ts";
import {
  ARTIFACT_PROJECTION_MAX_INLINE_BYTES,
  ARTIFACT_KINDS,
  defaultArtifactStore,
  issueBodyFromSnapshot,
  parseForgeUrl,
  prBodyFromSnapshot,
  projectArtifact,
  attachPrWorktree,
  removePrWorktree,
  type ArtifactRef,
} from "./index.ts";

describe("artifact kinds", () => {
  it("keeps the public kind surface limited to issue, git_change, and document", () => {
    expect(ARTIFACT_KINDS).toEqual(["issue", "git_change", "document"]);
  });

  it("CAS-updates daemon-managed Documents and requires an explicit reopen after sealing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-managed-document-"));
    const store = defaultArtifactStore(dir);
    const ref = "artifact:managed-workbench" as ArtifactRef;
    const first = await store.putManagedDocument({
      ref,
      bindingId: "workbench-binding-1",
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[]}',
      expectedRevision: null,
    });
    expect(first.artifact.body.revision).toBe(1);

    await expect(
      store.put({
        ref,
        kind: "document",
        title: "Forged Workbench",
        body: {
          ...first.artifact.body,
          mediaType: "text/markdown",
          content: "forged through generic put",
          revision: 1,
        },
      }),
    ).rejects.toThrow("managed Document writes require expected-revision authority");
    await expect(
      store.put({
        ref: "artifact:forged-managed" as ArtifactRef,
        kind: "document",
        title: "Forged managed document",
        body: {
          ...first.artifact.body,
          mediaType: "text/markdown",
          content: "forged managed creation",
          revision: 1,
        },
      }),
    ).rejects.toThrow("managed Document writes require expected-revision authority");
    await expect(
      store.update(ref, {
        body: {
          ...first.artifact.body,
          mediaType: "text/markdown",
          content: "forged through generic update",
          revision: 1,
        },
      }),
    ).rejects.toThrow("managed Document writes require expected-revision authority");

    await expect(
      store.putManagedDocument({
        ref,
        bindingId: "workbench-binding-1",
        title: "Workbench",
        mediaType: "application/vnd.a2ui+json",
        content: '{"messages":[{}]}',
        expectedRevision: null,
      }),
    ).rejects.toThrow("DOCUMENT_REVISION_CONFLICT");

    const sealed = await store.putManagedDocument({
      ref,
      bindingId: "workbench-binding-1",
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[{}]}',
      expectedRevision: 1,
      seal: true,
    });
    expect(sealed.artifact.body).toMatchObject({
      revision: 2,
      management: { lifecycle: "sealed" },
    });
    await expect(
      store.putManagedDocument({
        ref,
        bindingId: "workbench-binding-1",
        title: "Workbench",
        mediaType: "application/vnd.a2ui+json",
        content: '{"messages":[{"late":true}]}',
        expectedRevision: 2,
      }),
    ).rejects.toThrow("managed Document is sealed");
    await expect(
      store.update(ref, {
        body: {
          ...sealed.artifact.body,
          content: "forged",
          revision: 3,
        },
      }),
    ).rejects.toThrow("managed Document writes require expected-revision authority");
    const reopened = await store.putManagedDocument({
      ref,
      bindingId: "workbench-binding-1",
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[{"reopened":true}]}',
      expectedRevision: 2,
      reopen: true,
    });
    expect(reopened.artifact.body).toMatchObject({
      revision: 3,
      management: { lifecycle: "live" },
    });
  });

  it("serializes managed Document CAS so one concurrent stale writer loses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-managed-document-cas-"));
    const store = defaultArtifactStore(dir);
    const ref = "artifact:managed-cas" as ArtifactRef;
    await store.putManagedDocument({
      ref,
      bindingId: "workbench-binding-cas",
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"revision":1}',
      expectedRevision: null,
    });

    const results = await Promise.allSettled(
      ["a", "b"].map((writer) =>
        store.putManagedDocument({
          ref,
          bindingId: "workbench-binding-cas",
          title: "Workbench",
          mediaType: "application/vnd.a2ui+json",
          content: JSON.stringify({ writer }),
          expectedRevision: 1,
        }),
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("DOCUMENT_REVISION_CONFLICT"),
      }),
    });
    expect((await store.get(ref)).body).toMatchObject({ revision: 2 });

    const deadLock = join(
      dir,
      ".spark",
      "artifacts",
      ".managed-document-locks",
      "managed-cas.lock",
    );
    await mkdir(deadLock, { recursive: true });
    await writeFile(
      join(deadLock, "owner.json"),
      JSON.stringify({ hostname: hostname(), pid: 2_147_483_647, token: "dead-owner" }),
      "utf8",
    );
    await expect(
      store.putManagedDocument({
        ref,
        bindingId: "workbench-binding-cas",
        title: "Workbench",
        mediaType: "application/vnd.a2ui+json",
        content: '{"afterDeadOwner":true}',
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ artifact: { body: { revision: 3 } } });
  });

  it("rejects a blob whose bytes no longer match its metadata hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-managed-document-integrity-"));
    const store = defaultArtifactStore(dir);
    const ref = "artifact:managed-integrity" as ArtifactRef;
    await store.putManagedDocument({
      ref,
      bindingId: "workbench-binding-integrity",
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[]}',
      expectedRevision: null,
    });
    const metadata = JSON.parse(await readFile(store.pathFor(ref), "utf8")) as {
      blobPath?: string;
    };
    if (!metadata.blobPath) throw new Error("missing managed Document blobPath");
    const blobPath = join(dir, ".spark", "artifacts", metadata.blobPath);
    const body = JSON.parse(await readFile(blobPath, "utf8")) as Record<string, unknown>;
    body.content = '{"messages":[{"forged":true}]}';
    await writeFile(blobPath, JSON.stringify(body), "utf8");

    await expect(store.get(ref)).rejects.toThrow("artifact blob hash mismatch");

    const missingHashRef = "artifact:managed-missing-hash" as ArtifactRef;
    await store.putManagedDocument({
      ref: missingHashRef,
      bindingId: "workbench-binding-missing-hash",
      title: "Workbench",
      mediaType: "application/vnd.a2ui+json",
      content: '{"messages":[]}',
      expectedRevision: null,
    });
    const metadataPath = store.pathFor(missingHashRef);
    const missingHashMetadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete missingHashMetadata.hash;
    await writeFile(metadataPath, JSON.stringify(missingHashMetadata), "utf8");
    await expect(store.get(missingHashRef)).rejects.toThrow(
      "artifact blob metadata hash is missing",
    );
  });

  it("stores documents with continuous revisioned updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-artifact-preview-"));
    const store = defaultArtifactStore(dir);
    const created = await store.put({
      kind: "document",
      title: "Landing",
      format: "mdx",
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/mdx",
        content: "# Draft",
        revision: 1,
        progress: { label: "outline", percent: 10 },
      },
    });
    const updated = await store.update(created.ref, {
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/mdx",
        content: "# Draft\n\n## Section",
        revision: 2,
        progress: { label: "sections", percent: 40, stage: "writing" },
      },
    });
    expect(updated.body.kind).toBe("document");
    if (updated.body.kind !== "document") throw new Error("expected document");
    expect(updated.body.revision).toBe(2);
    expect(updated.body.progress?.percent).toBe(40);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    const listed = await store.list({ kind: "document" });
    expect(listed).toHaveLength(1);
  });

  it.each(["application/vnd.spark-ui+json", "text/plain", "application/json", "application/pdf"])(
    "rejects new Document writes with retired or unknown media type %s",
    async (mediaType) => {
      const dir = await mkdtemp(join(tmpdir(), "spark-artifact-retired-write-"));
      await expect(
        defaultArtifactStore(dir).put({
          kind: "document",
          title: "Retired",
          body: {
            schemaVersion: 2,
            kind: "document",
            mediaType,
            content: "retired",
            revision: 1,
          },
        } as never),
      ).rejects.toThrow(`document media type is retired or unsupported for writes: ${mediaType}`);
    },
  );

  it("normalizes v1 records but rejects removed Document media without changing refs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-artifact-legacy-normalize-"));
    const store = defaultArtifactStore(dir);
    await mkdir(store.rootDir, { recursive: true });
    const createdAt = "2026-07-01T00:00:00.000Z";
    await writeFile(
      store.pathFor("artifact:legacy-pr" as ArtifactRef),
      JSON.stringify({
        ref: "artifact:legacy-pr",
        kind: "pr",
        title: "Legacy PR",
        format: "json",
        body: {
          schemaVersion: 1,
          kind: "pr",
          forge: "github",
          repo: "acme/app",
          number: 9,
          url: "https://github.com/acme/app/pull/9",
          state: "open",
          title: "Legacy PR",
          headRef: "feature",
          baseRef: "main",
        },
        createdAt,
        updatedAt: createdAt,
      }),
      "utf8",
    );
    await writeFile(
      store.pathFor("artifact:legacy-preview" as ArtifactRef),
      JSON.stringify({
        ref: "artifact:legacy-preview",
        kind: "preview",
        title: "Legacy preview",
        format: "markdown",
        body: {
          schemaVersion: 1,
          kind: "preview",
          format: "md",
          content: "# Legacy",
          version: 4,
        },
        createdAt,
        updatedAt: createdAt,
      }),
      "utf8",
    );
    await writeFile(
      store.pathFor("artifact:retired-v2" as ArtifactRef),
      JSON.stringify({
        ref: "artifact:retired-v2",
        kind: "document",
        title: "Retired v2",
        format: "json",
        body: {
          schemaVersion: 2,
          kind: "document",
          mediaType: "application/vnd.spark-ui+json",
          content: "legacy source",
          revision: 2,
        },
        createdAt,
        updatedAt: createdAt,
      }),
      "utf8",
    );

    const pr = await store.get("artifact:legacy-pr" as ArtifactRef);
    expect(pr.ref).toBe("artifact:legacy-pr");
    expect(pr.body).toMatchObject({
      schemaVersion: 2,
      kind: "git_change",
      stack: { authority: "legacy-unbound" },
    });
    const document = await store.get("artifact:legacy-preview" as ArtifactRef);
    expect(document.ref).toBe("artifact:legacy-preview");
    expect(document.body).toMatchObject({
      schemaVersion: 2,
      kind: "document",
      mediaType: "text/markdown",
      revision: 4,
    });
    await expect(store.get("artifact:retired-v2" as ArtifactRef)).rejects.toThrow("invalid body");
    expect((await store.list()).map((artifact) => artifact.kind)).toEqual([
      "git_change",
      "document",
    ]);
  });

  it.each([
    { format: "spark-ui" },
    { format: "text" },
    { format: "json" },
    { mediaType: "application/vnd.spark-ui+json" },
    { mediaType: "text/plain" },
    { mediaType: "application/json" },
    { mediaType: "application/pdf" },
  ])("rejects retired or unknown tool Document writes: $format$mediaType", async (input) => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-artifact-retired-tool-create-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    await expect(
      tool.execute(
        "create-retired",
        {
          action: "create",
          kind: "document",
          title: "Rejected",
          content: "rejected",
          ...input,
        },
        new AbortController().signal,
        () => undefined,
        { cwd },
      ),
    ).rejects.toThrow(/format must be|mediaType must be/u);
  });

  it("syncs a cwd-local file and leaves identical content at the same revision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-artifact-sync-file-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    const artifactTool = tool;
    const signal = new AbortController().signal;
    const created = await artifactTool.execute(
      "create-sync-target",
      {
        action: "create",
        kind: "document",
        title: "Report",
        format: "md",
        content: "# Initial",
      },
      signal,
      () => undefined,
      { cwd },
    );
    const artifactRef = (created.details?.refs as { artifactRef?: string } | undefined)
      ?.artifactRef;
    if (!artifactRef) throw new Error("create did not return an Artifact ref");
    await mkdir(join(cwd, "outputs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "report.md"), "# Synced\n", "utf8");

    const first = await tool.execute(
      "sync-file-first",
      { action: "sync_file", artifactRef, sourcePath: "outputs/report.md" },
      signal,
      () => undefined,
      { cwd },
    );
    expect(first.details?.changed).toBe(true);
    const firstArtifact = first.details?.artifact as {
      body?: { revision?: number; content?: string };
      updatedAt?: string;
    };
    expect(firstArtifact.body).toMatchObject({ revision: 2, content: "# Synced\n" });

    const second = await tool.execute(
      "sync-file-noop",
      { action: "sync_file", artifactRef, sourcePath: "outputs/report.md" },
      signal,
      () => undefined,
      { cwd },
    );
    expect(second.details?.changed).toBe(false);
    const secondArtifact = second.details?.artifact as {
      body?: { revision?: number; content?: string };
      updatedAt?: string;
    };
    expect(secondArtifact.body).toMatchObject({ revision: 2, content: "# Synced\n" });
    expect(secondArtifact.updatedAt).toBe(firstArtifact.updatedAt);
  });

  it("rejects unsafe or oversized sync_file sources", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-artifact-sync-file-guards-"));
    const outside = await mkdtemp(join(tmpdir(), "spark-artifact-sync-file-outside-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    const artifactTool = tool;
    const signal = new AbortController().signal;
    const created = await artifactTool.execute(
      "create-guard-target",
      { action: "create", kind: "document", title: "Report", format: "md" },
      signal,
      () => undefined,
      { cwd },
    );
    const artifactRef = (created.details?.refs as { artifactRef?: string } | undefined)
      ?.artifactRef;
    if (!artifactRef) throw new Error("create did not return an Artifact ref");
    const outsidePath = join(outside, "outside.md");
    await writeFile(outsidePath, "outside", "utf8");
    const linkedPath = join(cwd, "linked.md");
    await symlink(outsidePath, linkedPath);
    await symlink(outside, join(cwd, "linked-directory"), "dir");
    const oversizedPath = join(cwd, "oversized.md");
    await writeFile(oversizedPath, "x".repeat(32 * 1024 + 1), "utf8");

    const sync = (sourcePath: string) =>
      artifactTool.execute(
        `sync-${sourcePath}`,
        { action: "sync_file", artifactRef, sourcePath },
        signal,
        () => undefined,
        { cwd },
      );
    await expect(sync(outsidePath)).rejects.toThrow("sourcePath must stay within cwd");
    await expect(sync("linked.md")).rejects.toThrow("sourcePath must not be a symbolic link");
    await expect(sync("linked-directory/outside.md")).rejects.toThrow(
      "sourcePath must stay within cwd",
    );
    await expect(sync(".")).rejects.toThrow("sourcePath must be a regular file");
    await expect(sync("oversized.md")).rejects.toThrow("32768-byte sync_file limit");
  });

  it("projects previews through a bounded coarse transport contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-artifact-projection-"));
    const store = defaultArtifactStore(dir);
    const markdown = await store.put({
      kind: "document",
      title: "Markdown",
      format: "markdown",
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/markdown",
        content: "# Durable",
        revision: 3,
        progress: { stage: "review", percent: 80 },
      },
    });
    expect(projectArtifact(markdown)).toEqual({
      schemaVersion: 1,
      format: "markdown",
      mime: "text/markdown",
      sizeBytes: Buffer.byteLength("# Durable"),
      hash: createHash("sha256").update("# Durable").digest("hex"),
      contentRef: {
        artifactRef: markdown.ref,
        mediaType: "text/markdown",
        revision: 3,
        previewFormat: "md",
        version: 3,
        progress: { stage: "review", percent: 80 },
        inlineMarkdown: "# Durable",
      },
    });

    const rich = await store.put({
      kind: "document",
      title: "HTML",
      format: "html",
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/html",
        content: "<main>Durable</main>",
        revision: 1,
      },
    });
    expect(projectArtifact(rich)).toMatchObject({
      format: "text",
      mime: "text/html",
      contentRef: {
        artifactRef: rich.ref,
        mediaType: "text/html",
        revision: 1,
        previewFormat: "html",
        version: 1,
        progress: null,
        inlineText: "<main>Durable</main>",
      },
    });

    const oversized = await store.put({
      kind: "document",
      title: "Oversized",
      format: "mdx",
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/mdx",
        content: "x".repeat(ARTIFACT_PROJECTION_MAX_INLINE_BYTES + 1),
        revision: 1,
      },
    });
    const projection = projectArtifact(oversized);
    expect(projection.sizeBytes).toBe(ARTIFACT_PROJECTION_MAX_INLINE_BYTES + 1);
    expect(projection.contentRef).not.toHaveProperty("inlineText");
    expect(projection.contentRef).not.toHaveProperty("inlineMarkdown");
  });

  it.each([
    {
      kind: "issue" as const,
      title: "Issue",
      body: {
        schemaVersion: 2 as const,
        kind: "issue" as const,
        forge: "github" as const,
        repo: "acme/app",
        number: 7,
        url: "https://github.com/acme/app/issues/7",
        state: "open",
        title: "Issue",
      },
    },
    {
      kind: "git_change" as const,
      title: "Change",
      body: {
        schemaVersion: 2 as const,
        kind: "git_change" as const,
        repository: { forge: "github" as const, repo: "acme/app" },
        trunk: "main",
        worktree: {
          path: "/tmp/change",
          branch: "feature",
          ownership: "external" as const,
          status: "attached" as const,
        },
        stack: {
          authority: "gh-stack" as const,
          currentBranch: "feature",
          entries: [
            {
              branch: "feature",
              base: "base-oid",
              isCurrent: true,
              isMerged: false,
              isQueued: false,
              needsRebase: false,
            },
          ],
        },
        lifecycle: "local" as const,
      },
    },
  ])("projects $kind bodies as bounded inline JSON", async ({ kind, title, body }) => {
    const dir = await mkdtemp(join(tmpdir(), `spark-artifact-${kind}-projection-`));
    const artifact = await defaultArtifactStore(dir).put({
      kind,
      title,
      format: "json",
      body,
    });
    const projection = projectArtifact(artifact);
    expect(projection).toMatchObject({
      schemaVersion: 1,
      format: "json",
      mime: "application/json",
      hash: createHash("sha256")
        .update(`${JSON.stringify(body, null, 2)}\n`)
        .digest("hex"),
      contentRef: {
        artifactRef: artifact.ref,
        inlineJson: { kind },
      },
    });
    expect(projection.sizeBytes).toBe(Buffer.byteLength(`${JSON.stringify(body, null, 2)}\n`));
  });

  it("puts projections on detail results but not list summaries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-artifact-projection-tool-"));
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    const signal = new AbortController().signal;
    const created = await tool.execute(
      "create-preview",
      {
        action: "create",
        kind: "document",
        title: "Hub document",
        format: "md",
        content: "# Persistent",
      },
      signal,
      () => undefined,
      { cwd, sessionSource: "tui", hasUI: true },
    );
    const artifact = created.details?.artifact;
    const artifactRef = (created.details?.refs as { artifactRef?: string } | undefined)
      ?.artifactRef;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || !artifactRef) {
      throw new Error("create result did not include the projected artifact");
    }
    const artifactRecord = artifact as Record<string, unknown>;
    expect(artifactRecord.projection).toMatchObject({
      schemaVersion: 1,
      format: "markdown",
      contentRef: { artifactRef: artifactRef, inlineMarkdown: "# Persistent" },
    });

    const opened = await tool.execute(
      "open-preview",
      { action: "open_preview", artifactRef },
      signal,
      () => undefined,
      { cwd, sessionSource: "tui", hasUI: true },
    );
    const openedArtifact = opened.details?.artifact;
    if (!openedArtifact || typeof openedArtifact !== "object" || Array.isArray(openedArtifact)) {
      throw new Error("open_preview result did not include the projected artifact");
    }
    const openedArtifactRecord = openedArtifact as Record<string, unknown>;
    expect(openedArtifactRecord.projection).toMatchObject({
      contentRef: { artifactRef: artifactRef },
    });

    const listed = await tool.execute("list-preview", { action: "list" }, signal, () => undefined, {
      cwd,
      sessionSource: "tui",
      hasUI: true,
    });
    const summaries = listed.details?.artifacts as Array<Record<string, unknown>>;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty("projection");
  });

  it("keeps Artifact state in the owning workspace while executing from another cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "spark-artifact-state-owner-"));
    const executionCwd = join(workspace, "worktree", "packages", "app");
    await mkdir(executionCwd, { recursive: true });
    let tool: ToolConfig | undefined;
    registerArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");

    await tool.execute(
      "workspace-owned-artifact",
      {
        action: "create",
        kind: "document",
        title: "Workspace owned",
        format: "md",
        content: "# State owner",
      },
      new AbortController().signal,
      () => undefined,
      { cwd: executionCwd, sparkStateRoot: join(workspace, ".spark") },
    );

    expect(await defaultArtifactStore(workspace).list()).toHaveLength(1);
    expect(await defaultArtifactStore(executionCwd).list()).toHaveLength(0);
  });

  it("parses forge issue and PR URLs", () => {
    expect(parseForgeUrl("https://github.com/acme/app/issues/12")).toEqual({
      forge: "github",
      repo: "acme/app",
      kind: "issue",
      number: 12,
    });
    expect(parseForgeUrl("https://github.com/acme/app/pull/9")).toEqual({
      forge: "github",
      repo: "acme/app",
      kind: "pr",
      number: 9,
    });
    expect(parseForgeUrl("https://gitlab.com/acme/app/-/merge_requests/3")).toEqual({
      forge: "gitlab",
      repo: "acme/app",
      kind: "pr",
      number: 3,
    });
  });

  it("maps forge snapshots into issue/pr bodies", () => {
    const issue = issueBodyFromSnapshot({
      forge: "github",
      repo: "acme/app",
      number: 1,
      url: "https://github.com/acme/app/issues/1",
      state: "open",
      title: "Bug",
      labels: ["bug"],
    });
    expect(issue.kind).toBe("issue");
    expect(issue.syncedAt).toBeTruthy();
    const pr = prBodyFromSnapshot({
      forge: "github",
      repo: "acme/app",
      number: 2,
      url: "https://github.com/acme/app/pull/2",
      state: "open",
      title: "Fix",
      labels: [],
      headRef: "feature",
      baseRef: "main",
      draft: false,
    });
    expect(pr.kind).toBe("pr");
    expect(pr.headRef).toBe("feature");
  });

  it("attaches and removes a PR worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-pr-worktree-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
    spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
    await writeFile(join(dir, "README.md"), "hello\n", "utf8");
    spawnSync("git", ["add", "."], { cwd: dir });
    const committed = spawnSync("git", ["commit", "-m", "init"], { cwd: dir, encoding: "utf8" });
    expect(committed.status).toBe(0);
    spawnSync("git", ["branch", "feature-pr"], { cwd: dir });

    const attached = await attachPrWorktree({
      cwd: dir,
      forge: "github",
      repo: "acme/app",
      number: 42,
      headRef: "feature-pr",
      baseRef: "main",
      runner: async (command, args, cwd) => {
        const result = spawnSync(command, args, { cwd, encoding: "utf8" });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          code: result.status ?? 1,
        };
      },
    });
    expect(attached.worktreeStatus).toBe("attached");
    expect(attached.worktreePath).toContain(".spark/worktrees/pr-github-acme-app-42");

    const removed = await removePrWorktree({
      cwd: dir,
      worktreePath: attached.worktreePath,
      force: true,
      runner: async (command, args, cwd) => {
        const result = spawnSync(command, args, { cwd, encoding: "utf8" });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
          code: result.status ?? 1,
        };
      },
    });
    expect(removed.worktreeStatus).toBe("removed");
  });

  it("keeps Artifacts and internal evidence in separate stores and ref namespaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-artifact-isolation-"));
    const artifactStore = defaultArtifactStore(dir);
    const evidenceStore = defaultEvidenceStore(dir);
    const artifact = await artifactStore.put({
      kind: "document",
      title: "Only Artifact",
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: "text/markdown",
        content: "hi",
        revision: 1,
      },
    });
    const evidence = await evidenceStore.put({
      kind: "record",
      title: "Internal proof",
      format: "json",
      body: { passed: true },
      provenance: { producer: "review" },
    });
    await writeFile(
      join(dir, ".spark", "artifacts", "legacy-invalid-evidence.json"),
      JSON.stringify({ artifactRef: "artifact:legacy-evidence", kind: "trace" }),
      "utf8",
    );

    expect(artifact.ref).toMatch(/^artifact:/u);
    expect(evidence.ref).toMatch(/^evidence:/u);
    expect(artifactStore.rootDir).toBe(join(dir, ".spark", "artifacts"));
    expect(evidenceStore.rootDir).toBe(join(dir, ".spark", "evidence"));
    await expect(stat(artifactStore.pathFor(artifact.ref))).resolves.toBeDefined();
    await expect(stat(evidenceStore.pathFor(evidence.ref))).resolves.toBeDefined();
    await expect(
      stat(join(dir, ".spark", "artifacts", `${evidence.ref.slice("evidence:".length)}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(dir, ".spark", "evidence", `${artifact.ref.slice("artifact:".length)}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await artifactStore.list()).map((item) => item.ref)).toEqual([artifact.ref]);
    expect((await evidenceStore.list()).map((item) => item.ref)).toEqual([evidence.ref]);
    await expect(evidenceStore.get(artifact.ref as unknown as EvidenceRef)).rejects.toThrow(
      /must be an evidence: ref/u,
    );
    await expect(artifactStore.get(evidence.ref as unknown as ArtifactRef)).rejects.toThrow(
      /artifact ref must be artifact/u,
    );
  });
});
