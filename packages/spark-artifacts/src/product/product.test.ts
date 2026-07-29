import { createHash } from "node:crypto";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolConfig } from "@zendev-lab/spark-core";
import { describe, expect, it } from "vitest";
import { defaultEvidenceStore, type EvidenceRef } from "../index.ts";
import { registerProductArtifactTool } from "./extension.ts";
import {
  PRODUCT_ARTIFACT_PROJECTION_MAX_INLINE_BYTES,
  PRODUCT_ARTIFACT_KINDS,
  defaultProductArtifactStore,
  issueBodyFromSnapshot,
  parseForgeUrl,
  prBodyFromSnapshot,
  projectProductArtifact,
  attachPrWorktree,
  removePrWorktree,
  type ProductArtifactRef,
} from "./index.ts";

describe("product artifact kinds", () => {
  it("keeps the public kind surface limited to issue, pr, and preview", () => {
    expect(PRODUCT_ARTIFACT_KINDS).toEqual(["issue", "pr", "preview"]);
  });

  it("stores preview with continuous versioned updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-product-preview-"));
    const store = defaultProductArtifactStore(dir);
    const created = await store.put({
      kind: "preview",
      title: "Landing",
      format: "mdx",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "mdx",
        content: "# Draft",
        version: 1,
        progress: { label: "outline", percent: 10 },
      },
    });
    const updated = await store.update(created.ref, {
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "mdx",
        content: "# Draft\n\n## Section",
        version: 2,
        progress: { label: "sections", percent: 40, stage: "writing" },
      },
    });
    expect(updated.body.kind).toBe("preview");
    if (updated.body.kind !== "preview") throw new Error("expected preview");
    expect(updated.body.version).toBe(2);
    expect(updated.body.progress?.percent).toBe(40);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
    const listed = await store.list({ kind: "preview" });
    expect(listed).toHaveLength(1);
  });

  it("projects previews through a bounded coarse transport contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-product-projection-"));
    const store = defaultProductArtifactStore(dir);
    const markdown = await store.put({
      kind: "preview",
      title: "Markdown",
      format: "markdown",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "md",
        content: "# Durable",
        version: 3,
        progress: { stage: "review", percent: 80 },
      },
    });
    expect(projectProductArtifact(markdown)).toEqual({
      schemaVersion: 1,
      format: "markdown",
      mime: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength("# Durable"),
      hash: createHash("sha256").update("# Durable").digest("hex"),
      contentRef: {
        productArtifactRef: markdown.ref,
        previewFormat: "md",
        version: 3,
        progress: { stage: "review", percent: 80 },
        inlineMarkdown: "# Durable",
      },
    });

    const rich = await store.put({
      kind: "preview",
      title: "HTML",
      format: "html",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "html",
        content: "<main>Durable</main>",
        version: 1,
      },
    });
    expect(projectProductArtifact(rich)).toMatchObject({
      format: "text",
      mime: "text/plain; charset=utf-8",
      contentRef: {
        productArtifactRef: rich.ref,
        previewFormat: "html",
        version: 1,
        progress: null,
        inlineText: "<main>Durable</main>",
      },
    });

    const oversized = await store.put({
      kind: "preview",
      title: "Oversized",
      format: "mdx",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "mdx",
        content: "x".repeat(PRODUCT_ARTIFACT_PROJECTION_MAX_INLINE_BYTES + 1),
        version: 1,
      },
    });
    const projection = projectProductArtifact(oversized);
    expect(projection.sizeBytes).toBe(PRODUCT_ARTIFACT_PROJECTION_MAX_INLINE_BYTES + 1);
    expect(projection.contentRef).not.toHaveProperty("inlineText");
    expect(projection.contentRef).not.toHaveProperty("inlineMarkdown");
  });

  it.each([
    {
      kind: "issue" as const,
      title: "Issue",
      body: {
        schemaVersion: 1 as const,
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
      kind: "pr" as const,
      title: "PR",
      body: {
        schemaVersion: 1 as const,
        kind: "pr" as const,
        forge: "github" as const,
        repo: "acme/app",
        number: 8,
        url: "https://github.com/acme/app/pull/8",
        state: "open",
        title: "PR",
        headRef: "feature",
        baseRef: "main",
      },
    },
  ])("projects $kind bodies as bounded inline JSON", async ({ kind, title, body }) => {
    const dir = await mkdtemp(join(tmpdir(), `spark-product-${kind}-projection-`));
    const artifact = await defaultProductArtifactStore(dir).put({
      kind,
      title,
      format: "json",
      body,
    });
    const projection = projectProductArtifact(artifact);
    expect(projection).toMatchObject({
      schemaVersion: 1,
      format: "json",
      mime: "application/json",
      hash: createHash("sha256")
        .update(`${JSON.stringify(body, null, 2)}\n`)
        .digest("hex"),
      contentRef: {
        productArtifactRef: artifact.ref,
        inlineJson: { kind },
      },
    });
    expect(projection.sizeBytes).toBe(Buffer.byteLength(`${JSON.stringify(body, null, 2)}\n`));
  });

  it("puts projections on detail results but not list summaries", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-product-projection-tool-"));
    let tool: ToolConfig | undefined;
    registerProductArtifactTool({ registerTool: (config) => (tool = config) });
    if (!tool) throw new Error("artifact tool was not registered");
    const signal = new AbortController().signal;
    const created = await tool.execute(
      "create-preview",
      {
        action: "create",
        kind: "preview",
        title: "Cockpit preview",
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
      contentRef: { productArtifactRef: artifactRef, inlineMarkdown: "# Persistent" },
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
      contentRef: { productArtifactRef: artifactRef },
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

  it("keeps Product Artifacts and internal evidence in separate stores and ref namespaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-product-isolation-"));
    const productStore = defaultProductArtifactStore(dir);
    const evidenceStore = defaultEvidenceStore(dir);
    const product = await productStore.put({
      kind: "preview",
      title: "Only product",
      body: {
        schemaVersion: 1,
        kind: "preview",
        format: "md",
        content: "hi",
        version: 1,
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

    expect(product.ref).toMatch(/^artifact:/u);
    expect(evidence.ref).toMatch(/^evidence:/u);
    expect(productStore.rootDir).toBe(join(dir, ".spark", "artifacts"));
    expect(evidenceStore.rootDir).toBe(join(dir, ".spark", "evidence"));
    await expect(stat(productStore.pathFor(product.ref))).resolves.toBeDefined();
    await expect(stat(evidenceStore.pathFor(evidence.ref))).resolves.toBeDefined();
    await expect(
      stat(join(dir, ".spark", "artifacts", `${evidence.ref.slice("evidence:".length)}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      stat(join(dir, ".spark", "evidence", `${product.ref.slice("artifact:".length)}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await productStore.list()).map((item) => item.ref)).toEqual([product.ref]);
    expect((await evidenceStore.list()).map((item) => item.ref)).toEqual([evidence.ref]);
    await expect(evidenceStore.get(product.ref as unknown as EvidenceRef)).rejects.toThrow(
      /must be an evidence: ref/u,
    );
    await expect(productStore.get(evidence.ref as unknown as ProductArtifactRef)).rejects.toThrow(
      /product artifact ref must be artifact/u,
    );
  });
});
