import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import piFilesExtension, {
  atomicReplaceTextFiles,
  contentVersion,
  createReadToolConfig,
  truncateHead,
  truncateLine,
  applyEditsToNormalizedContent,
  generateDiffString,
  walkTree,
  DEFAULT_MAX_BYTES,
  DEFAULT_READ_MAX_LINES,
  DEFAULT_READ_MAX_BYTES,
  registerSparkFilesTools,
} from "./index.ts";
import { defaultArtifactStore } from "@zendev-lab/spark-artifacts";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolConfig {
  name: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: { cwd?: string; sparkStateRoot?: string; taskExecutionScope?: unknown },
  ): Promise<ToolResult>;
}

function collectTools(
  register: (api: { registerTool: (c: ToolConfig) => void }) => void,
): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  register({ registerTool: (config) => tools.set(config.name, config as ToolConfig) });
  return tools;
}

const idleSignal = new AbortController().signal;

const noop = () => {};
const text = (result: ToolResult): string => result.content.map((c) => c.text).join("\n");

interface ReadLineAnchor {
  line: number;
  hash: string;
  anchor: string;
  text: string;
}

interface ReadDetails {
  version: string;
  sizeBytes: number;
  bom: "utf8" | "none";
  lineEnding: "none" | "lf" | "crlf" | "cr" | "mixed";
  totalLines: number;
  window: {
    startLine: number;
    endLine?: number;
    nextOffset?: number;
    requestedLimit?: number;
    anchors: ReadLineAnchor[];
  };
}

function readDetails(result: ToolResult): ReadDetails {
  return result.details as unknown as ReadDetails;
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-files-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("spark-files exposes one tool per file operation", () => {
  const tools = collectTools(piFilesExtension);
  assert.deepEqual([...tools.keys()].sort(), ["edit", "find", "grep", "read", "write"]);
});

test("read repair refines the ordinary read policy into a sequential write", () => {
  const read = createReadToolConfig();
  assert.deepEqual(read.resolvePolicy?.({ path: "index.ts" }), {
    effect: "read",
    executionMode: "parallel",
    domains: ["files"],
    modes: ["plan", "execute", "fleet"],
    approval: "none",
  });
  assert.deepEqual(read.resolvePolicy?.({ path: "index.ts", repair: "format" }), {
    effect: "local_write",
    executionMode: "sequential",
    domains: ["files"],
    modes: ["execute"],
    approval: "none",
  });
});

test("task execution scopes fail closed for readonly, traversal, symlink, and unauthorized refs", async () => {
  await withTempDir(async (dir) => {
    const primary = join(dir, "primary");
    const secondary = join(dir, "secondary");
    const outside = join(dir, "outside");
    await Promise.all([mkdir(primary), mkdir(secondary), mkdir(outside)]);
    await symlink(outside, join(primary, "escape"));
    const write = collectTools(piFilesExtension).get("write")!;
    const primaryRef = "artifact:primary";
    const secondaryRef = "artifact:secondary";
    const baseScope = {
      isolation: "isolated_worktree",
      primaryArtifactRef: primaryRef,
      writableArtifactRefs: [primaryRef, secondaryRef],
      writableRoots: [primary, secondary],
    };

    await assert.rejects(
      write.execute(
        "readonly",
        { path: "blocked.txt", content: "x", expectedVersion: "missing" },
        undefined,
        noop,
        { cwd: primary, taskExecutionScope: { ...baseScope, isolation: "readonly" } },
      ),
      /readonly/u,
    );
    await assert.rejects(
      write.execute(
        "traversal",
        { path: "../outside/traversal.txt", content: "x", expectedVersion: "missing" },
        undefined,
        noop,
        { cwd: primary, taskExecutionScope: baseScope },
      ),
      /escapes its scope/u,
    );
    await assert.rejects(
      write.execute(
        "symlink",
        { path: "escape/symlink.txt", content: "x", expectedVersion: "missing" },
        undefined,
        noop,
        { cwd: primary, taskExecutionScope: baseScope },
      ),
      /crosses a symlink/u,
    );
    await assert.rejects(
      write.execute(
        "unauthorized",
        {
          path: "blocked.txt",
          artifactRef: "artifact:other",
          content: "x",
          expectedVersion: "missing",
        },
        undefined,
        noop,
        { cwd: primary, taskExecutionScope: baseScope },
      ),
      /not authorized/u,
    );

    const allowed = await write.execute(
      "secondary",
      {
        path: "allowed.txt",
        artifactRef: secondaryRef,
        content: "ok",
        expectedVersion: "missing",
      },
      undefined,
      noop,
      { cwd: primary, taskExecutionScope: baseScope },
    );
    assert.equal(allowed.isError, undefined);
    assert.equal(await readFile(join(secondary, "allowed.txt"), "utf8"), "ok");
    await assert.rejects(stat(join(outside, "traversal.txt")));
    await assert.rejects(stat(join(outside, "symlink.txt")));
  });
});

test("isolated_results writes only below the daemon-resolved job root", async () => {
  await withTempDir(async (dir) => {
    const resultsRoot = join(dir, ".spark", "task-results", "job_1");
    await mkdir(resultsRoot, { recursive: true });
    const write = collectTools(piFilesExtension).get("write")!;
    const ctx = {
      cwd: dir,
      taskExecutionScope: {
        isolation: "isolated_results",
        writableArtifactRefs: [],
        writableRoots: [],
        resultsRoot,
      },
    };
    const result = await write.execute(
      "results",
      { path: "result.json", content: "{}", expectedVersion: "missing" },
      undefined,
      noop,
      ctx,
    );
    assert.equal(result.isError, undefined);
    assert.equal(await readFile(join(resultsRoot, "result.json"), "utf8"), "{}");
    await assert.rejects(
      write.execute(
        "results-ref",
        {
          path: "blocked.txt",
          artifactRef: "artifact:primary",
          content: "x",
          expectedVersion: "missing",
        },
        undefined,
        noop,
        ctx,
      ),
      /cannot write a git_change Artifact/u,
    );
  });
});

test("workspace scope writes across nested repositories but rejects escape and Artifact selection", async () => {
  await withTempDir(async (dir) => {
    const workspace = join(dir, "workspace");
    const repository = join(workspace, "repos", "target");
    const outside = join(dir, "outside");
    await Promise.all([
      mkdir(repository, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ]);
    const write = collectTools(piFilesExtension).get("write")!;
    const ctx = {
      cwd: workspace,
      taskExecutionScope: {
        isolation: "workspace",
        writableArtifactRefs: [],
        writableRoots: [workspace],
      },
    };

    await write.execute(
      "workspace",
      { path: "repos/target/change.txt", content: "ok", expectedVersion: "missing" },
      undefined,
      noop,
      ctx,
    );
    assert.equal(await readFile(join(repository, "change.txt"), "utf8"), "ok");
    await assert.rejects(
      write.execute(
        "workspace-artifact",
        {
          path: "change.txt",
          artifactRef: "artifact:unexpected",
          content: "x",
          expectedVersion: "missing",
        },
        undefined,
        noop,
        ctx,
      ),
      /does not preselect/u,
    );
    await assert.rejects(
      write.execute(
        "workspace-escape",
        { path: "../outside/escape.txt", content: "x", expectedVersion: "missing" },
        undefined,
        noop,
        ctx,
      ),
      /escapes its scope/u,
    );
  });
});

test("read expectedVersion fails closed without returning a newer snapshot", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    await writeFile(join(dir, "guarded.txt"), "first", "utf8");
    const first = await read.execute("first", { path: "guarded.txt" }, undefined, noop, {
      cwd: dir,
    });
    await writeFile(join(dir, "guarded.txt"), "second", "utf8");
    const conflict = await read.execute(
      "stale",
      { path: "guarded.txt", expectedVersion: readDetails(first).version },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(conflict.isError, true);
    assert.equal(conflict.details?.code, "VERSION_CONFLICT");
    assert.doesNotMatch(text(conflict), /second/u);
  });
});

test("blank artifactRef uses the selected cwd across file tools", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const write = tools.get("write")!;
    const read = tools.get("read")!;
    const edit = tools.get("edit")!;
    const grep = tools.get("grep")!;
    const find = tools.get("find")!;

    const created = await write.execute(
      "blank-artifact-write",
      {
        path: "selected.txt",
        artifactRef: "",
        content: "needle before\n",
        expectedVersion: "missing",
      },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(created.isError ?? false, false);

    const selected = await read.execute(
      "blank-artifact-read",
      { path: "selected.txt", artifactRef: "" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(selected), /needle before/u);

    const edited = await edit.execute(
      "blank-artifact-edit",
      {
        path: "selected.txt",
        artifactRef: "",
        edits: [{ oldText: "needle before", newText: "needle after" }],
      },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(edited.isError ?? false, false);

    const matches = await grep.execute(
      "blank-artifact-grep",
      { pattern: "needle after", artifactRef: "" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(matches), /selected\.txt:1: needle after/u);

    const files = await find.execute(
      "blank-artifact-find",
      { pattern: "*.txt", artifactRef: "" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(files), /selected\.txt/u);

    await assert.rejects(
      read.execute(
        "invalid-artifact-read",
        { path: "selected.txt", artifactRef: "not-an-artifact" },
        undefined,
        noop,
        { cwd: dir },
      ),
      /artifactRef must be an artifact: ref/u,
    );
  });
});

test("batch CAS checks every file before promoting any content", async () => {
  await withTempDir(async (dir) => {
    const first = join(dir, "first.txt");
    const second = join(dir, "second.txt");
    await writeFile(first, "first-v1");
    await writeFile(second, "second-v1");
    const firstVersion = contentVersion(Buffer.from("first-v1"));
    const secondVersion = contentVersion(Buffer.from("second-v1"));

    const conflict = await atomicReplaceTextFiles([
      { filePath: first, content: "first-v2", expectedVersion: firstVersion },
      {
        filePath: second,
        content: "second-v2",
        expectedVersion: contentVersion(Buffer.from("stale")),
      },
    ]);
    assert.equal(conflict.ok, false);
    assert.equal(await readFile(first, "utf8"), "first-v1");
    assert.equal(await readFile(second, "utf8"), "second-v1");

    const promoted = await atomicReplaceTextFiles([
      { filePath: first, content: "first-v2", expectedVersion: firstVersion },
      { filePath: second, content: "second-v2", expectedVersion: secondVersion },
    ]);
    assert.equal(promoted.ok, true);
    assert.equal(await readFile(first, "utf8"), "first-v2");
    assert.equal(await readFile(second, "utf8"), "second-v2");
  });
});

test("relative paths route through an attached git_change Artifact worktree", async () => {
  await withTempDir(async (dir) => {
    const sessionCwd = join(dir, "packages", "session");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(sessionCwd, "selected.txt"), "from selected cwd\n", "utf8");
    const worktree = join(dir, "managed-worktree");
    await mkdir(worktree);
    await writeFile(join(worktree, "artifact.txt"), "from artifact worktree\n", "utf8");
    const artifact = await defaultArtifactStore(dir).put({
      kind: "git_change",
      title: "Managed change",
      body: {
        schemaVersion: 2,
        kind: "git_change",
        repository: { forge: "github", repo: "acme/app" },
        trunk: "main",
        worktree: {
          path: worktree,
          branch: "feature",
          ownership: "spark",
          status: "attached",
        },
        stack: {
          authority: "gh-stack",
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
        lifecycle: "local",
      },
    });

    const read = collectTools(piFilesExtension).get("read")!;
    const result = await read.execute(
      "artifact-read",
      { path: "artifact.txt", artifactRef: artifact.ref },
      undefined,
      noop,
      { cwd: sessionCwd, sparkStateRoot: join(dir, ".spark") },
    );
    assert.match(text(result), /from artifact worktree/u);
    assert.equal(result.details?.artifactRef, artifact.ref);

    const write = collectTools(piFilesExtension).get("write")!;
    const artifactWrite = await write.execute(
      "artifact-write",
      {
        path: "created-in-artifact.txt",
        artifactRef: artifact.ref,
        content: "created in artifact worktree\n",
        expectedVersion: "missing",
      },
      undefined,
      noop,
      { cwd: sessionCwd, sparkStateRoot: join(dir, ".spark") },
    );
    assert.equal(artifactWrite.isError ?? false, false);
    assert.equal(
      await readFile(join(worktree, "created-in-artifact.txt"), "utf8"),
      "created in artifact worktree\n",
    );

    const edit = collectTools(piFilesExtension).get("edit")!;
    const artifactEdit = await edit.execute(
      "artifact-edit",
      {
        path: "artifact.txt",
        artifactRef: artifact.ref,
        edits: [{ oldText: "from artifact worktree", newText: "from edited artifact worktree" }],
      },
      undefined,
      noop,
      { cwd: sessionCwd, sparkStateRoot: join(dir, ".spark") },
    );
    assert.equal(artifactEdit.isError ?? false, false);
    assert.equal(
      await readFile(join(worktree, "artifact.txt"), "utf8"),
      "from edited artifact worktree\n",
    );

    const grep = collectTools(piFilesExtension).get("grep")!;
    const artifactMatch = await grep.execute(
      "artifact-grep",
      { pattern: "from edited artifact", artifactRef: artifact.ref },
      undefined,
      noop,
      { cwd: sessionCwd, sparkStateRoot: join(dir, ".spark") },
    );
    assert.match(text(artifactMatch), /artifact\.txt:1: from edited artifact worktree/u);
    assert.equal(artifactMatch.details?.artifactRef, artifact.ref);

    const find = collectTools(piFilesExtension).get("find")!;
    const artifactFile = await find.execute(
      "artifact-find",
      { pattern: "artifact.txt", artifactRef: artifact.ref },
      undefined,
      noop,
      { cwd: sessionCwd, sparkStateRoot: join(dir, ".spark") },
    );
    assert.match(text(artifactFile), /artifact\.txt/u);
    assert.equal(artifactFile.details?.artifactRef, artifact.ref);

    const selected = await read.execute(
      "selected-cwd-read",
      { path: "selected.txt" },
      undefined,
      noop,
      { cwd: sessionCwd, sparkStateRoot: join(dir, ".spark") },
    );
    assert.match(text(selected), /from selected cwd/u);
  });
});

test("paginated reads reconstruct a version-consistent file without gaps", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const lines = Array.from({ length: 8 }, (_, index) => `snapshot-line-${index + 1}`);
    await writeFile(join(dir, "snapshot.txt"), lines.join("\n"), "utf-8");

    const versions = new Set<string>();
    const anchors: ReadLineAnchor[] = [];
    let nextOffset: number | undefined = 1;
    let pageCount = 0;
    while (nextOffset !== undefined) {
      assert.ok(pageCount < lines.length, "pagination did not terminate");
      const pageOffset: number = nextOffset;
      const result = await read.execute(
        `page-${pageOffset}`,
        { path: "snapshot.txt", offset: pageOffset, limit: 3 },
        undefined,
        noop,
        { cwd: dir },
      );
      assert.equal(result.isError ?? false, false);
      const details = readDetails(result);
      versions.add(details.version);
      anchors.push(...details.window.anchors);
      nextOffset = details.window.nextOffset;
      if (nextOffset !== undefined) assert.ok(nextOffset > pageOffset);
      pageCount += 1;
    }

    assert.equal(pageCount, 3);
    assert.equal(versions.size, 1);
    assert.deepEqual(
      anchors.map((anchor) => anchor.line),
      lines.map((_, index) => index + 1),
    );
    assert.deepEqual(
      anchors.map((anchor) => anchor.text),
      lines,
    );
  });
});

test("read exposes model-visible version, anchors, and continuation", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const lines = Array.from({ length: 6 }, (_, index) => `line${index + 1}`);
    await writeFile(join(dir, "visible.txt"), lines.join("\n"), "utf-8");

    const result = await read.execute(
      "c",
      { path: "visible.txt", offset: 2, limit: 2 },
      undefined,
      noop,
      { cwd: dir },
    );
    const details = readDetails(result);
    assert.equal(
      text(result),
      [
        `[File version: ${details.version}]`,
        details.window.anchors.map((anchor) => anchor.anchor).join("\n"),
        "[3 more lines in file. Use offset=4 to continue.]",
      ].join("\n\n"),
    );
    assert.match(text(result), /^\[File version: sha256:[0-9a-f]{64}\]/u);
    assert.match(text(result), /\n\n2#[0-9a-f]{12}:line2\n3#[0-9a-f]{12}:line3\n\n/u);
  });
});

test("read returns stable content versions and copyable anchors across windows", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const path = join(dir, "anchored.txt");
    await writeFile(path, "alpha\nbeta\ngamma", "utf-8");

    const full = await read.execute("c", { path: "anchored.txt" }, undefined, noop, {
      cwd: dir,
    });
    const windowed = await read.execute(
      "c",
      { path: "anchored.txt", offset: 2, limit: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    const fullDetails = readDetails(full);
    const windowDetails = readDetails(windowed);
    assert.match(fullDetails.version, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(windowDetails.version, fullDetails.version);
    assert.deepEqual(windowDetails.window.anchors[0], fullDetails.window.anchors[1]);
    assert.match(windowDetails.window.anchors[0]!.anchor, /^2#[0-9a-f]{12}:beta$/u);

    await writeFile(path, "alpha\nbeta\nchanged", "utf-8");
    const changed = await read.execute(
      "c",
      { path: "anchored.txt", offset: 2, limit: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.notEqual(readDetails(changed).version, fullDetails.version);
    assert.deepEqual(readDetails(changed).window.anchors[0], windowDetails.window.anchors[0]);
  });
});

test("read reports BOM and CRLF metadata while rendering logical anchors", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const path = join(dir, "windows.txt");
    const original = "\uFEFFalpha\r\nbeta\r\n";
    await writeFile(path, original, "utf-8");

    const result = await read.execute("c", { path: "windows.txt" }, undefined, noop, {
      cwd: dir,
    });
    const details = readDetails(result);
    assert.doesNotMatch(text(result), /\r/u);
    assert.doesNotMatch(text(result), /\uFEFF/u);
    assert.equal(details.bom, "utf8");
    assert.equal(details.lineEnding, "crlf");
    assert.equal(details.sizeBytes, Buffer.byteLength(original, "utf-8"));
    assert.deepEqual(
      details.window.anchors.slice(0, 2).map((anchor) => anchor.text),
      ["alpha", "beta"],
    );

    await writeFile(path, "alpha\nbeta\n", "utf-8");
    const normalized = await read.execute("c", { path: "windows.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.notEqual(readDetails(normalized).version, details.version);
    assert.deepEqual(
      readDetails(normalized)
        .window.anchors.slice(0, 2)
        .map((anchor) => anchor.hash),
      details.window.anchors.slice(0, 2).map((anchor) => anchor.hash),
    );
  });
});

test("read reports CR-only and mixed line endings with one logical-anchor format", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const crOnly = "alpha\rbeta\rgamma\r";
    await writeFile(join(dir, "classic-mac.txt"), crOnly, "utf-8");

    const fullCr = await read.execute("cr-full", { path: "classic-mac.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(readDetails(fullCr).lineEnding, "cr");
    assert.equal(readDetails(fullCr).totalLines, 4);
    assert.deepEqual(
      readDetails(fullCr).window.anchors.map((anchor) => anchor.text),
      ["alpha", "beta", "gamma", ""],
    );

    const crWindow = await read.execute(
      "cr-window",
      { path: "classic-mac.txt", offset: 2, limit: 2 },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(readDetails(crWindow).window.nextOffset, 4);
    assert.deepEqual(
      readDetails(crWindow).window.anchors.map((anchor) => anchor.text),
      ["beta", "gamma"],
    );

    const mixed = "one\r\ntwo\rthree\nfour";
    await writeFile(join(dir, "mixed.txt"), mixed, "utf-8");
    const fullMixed = await read.execute("mixed-full", { path: "mixed.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(readDetails(fullMixed).lineEnding, "mixed");
    assert.deepEqual(
      readDetails(fullMixed).window.anchors.map((anchor) => anchor.text),
      ["one", "two", "three", "four"],
    );
  });
});

test("read reports a missing file as an error result", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const result = await read.execute("c", { path: "missing.txt" }, undefined, noop, { cwd: dir });
    assert.equal(result.isError, true);
    assert.match(text(result), /Could not read file/);
  });
});

test("read rejects invalid UTF-8 instead of returning replacement characters", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    await writeFile(join(dir, "binary.dat"), Buffer.from([0xff, 0xfe, 0x00]));
    const result = await read.execute("invalid-utf8", { path: "binary.dat" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(result.isError, true);
    assert.equal(result.details?.code, "INVALID_UTF8");
  });
});

test("read truncates by line limit with a continuation notice", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const total = DEFAULT_READ_MAX_LINES + 50;
    const content = Array.from({ length: total }, (_, i) => `L${i + 1}`).join("\n");
    await writeFile(join(dir, "big.txt"), content, "utf-8");
    const result = await read.execute("c", { path: "big.txt", page: 1 }, undefined, noop, {
      cwd: dir,
    });
    assert.match(text(result), new RegExp(`Showing lines 1-${DEFAULT_READ_MAX_LINES} of ${total}`));
    assert.match(text(result), /Use offset=\d+ to continue/u);
    assert.equal(
      (result.details?.truncation as { truncated?: boolean } | undefined)?.truncated,
      undefined,
    );
  });
});

test("read applies the byte limit to the final anchored output", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const lines = Array.from(
      { length: 1_500 },
      (_, index) => `${String(index).padStart(4, "0")}-${"x".repeat(20)}`,
    );
    await writeFile(join(dir, "anchored-budget.txt"), lines.join("\n"), "utf-8");

    const result = await read.execute(
      "anchored-budget",
      { path: "anchored-budget.txt", maxBytes: 2 * 1024, page: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    const truncation = result.details?.truncation as { truncatedBy?: string } | undefined;

    assert.ok(Buffer.byteLength(text(result), "utf8") <= 2 * 1024);
    assert.match(text(result), /2\.0KB output limit/u);
    assert.equal(truncation?.truncatedBy, "bytes");
    assert.ok(readDetails(result).window.anchors.length < lines.length);
    assert.equal(
      readDetails(result).window.nextOffset,
      readDetails(result).window.anchors.length + 1,
    );
  });
});

test("read truncates over-limit files by default with a resumable hint", async () => {
  await withTempDir(async (dir) => {
    const read = collectTools(piFilesExtension).get("read")!;
    const lines = Array.from({ length: 1_200 }, (_, index) => `L${index + 1} ${"x".repeat(30)}`);
    await writeFile(join(dir, "large.txt"), lines.join("\n"), "utf-8");

    const result = await read.execute("c", { path: "large.txt", page: 1 }, undefined, noop, {
      cwd: dir,
    });
    const textOut = text(result);
    const details = readDetails(result);

    assert.ok(Buffer.byteLength(textOut, "utf8") <= DEFAULT_READ_MAX_BYTES);
    assert.match(textOut, /16\.0KB output limit/u);
    assert.equal(
      (result.details?.truncation as { truncated?: boolean } | undefined)?.truncated,
      true,
    );
    assert.equal(result.details?.maxBytes, DEFAULT_READ_MAX_BYTES);
    assert.equal(result.details?.maxLines, DEFAULT_READ_MAX_LINES);
    assert.ok(details.window.anchors.length > 0);

    // The advertised page navigates to the next window.
    const continued = await read.execute(
      "c-next",
      { path: "large.txt", page: 2 },
      idleSignal,
      noop,
      {
        cwd: dir,
      },
    );
    const continuedDetails = readDetails(continued);
    assert.equal(continuedDetails.window.anchors[0]?.text, lines[DEFAULT_READ_MAX_LINES]);
  });
});

test("read maxBytes overrides the default output cap in both directions", async () => {
  await withTempDir(async (dir) => {
    const read = createReadToolConfig();
    const lines = Array.from(
      { length: 1_200 },
      (_, index) => `line ${index + 1} ${"x".repeat(30)}`,
    );
    await writeFile(join(dir, "override.txt"), lines.join("\n"), "utf-8");

    // Raising the caps returns the whole file instead of truncating at 16KB.
    const full = await read.execute(
      "c-full",
      { path: "override.txt", maxBytes: 256 * 1024, maxLines: 1_200 },
      idleSignal,
      noop,
      { cwd: dir },
    );
    assert.equal(
      (full.details?.truncation as { truncated?: boolean } | undefined)?.truncated,
      undefined,
    );
    assert.equal(readDetails(full).window.anchors.length, lines.length);
    assert.equal(full.details?.maxBytes, 256 * 1024);

    // Lowering the cap hardens the budget for one call.
    const lowered = await read.execute(
      "c-small",
      { path: "override.txt", maxBytes: 4 * 1024 },
      idleSignal,
      noop,
      { cwd: dir },
    );
    assert.ok(Buffer.byteLength(text(lowered), "utf8") <= 4 * 1024);
    assert.match(text(lowered), /4\.0KB output limit/u);
    assert.equal(lowered.details?.maxBytes, 4 * 1024);
  });
});

test("read maxLines overrides the default line cap and defaults to the last page", async () => {
  await withTempDir(async (dir) => {
    const read = createReadToolConfig();
    const total = 100;
    const lines = Array.from({ length: total }, (_, i) => `L${i + 1}`);
    await writeFile(join(dir, "many.txt"), lines.join("\n"), "utf-8");

    const result = await read.execute("c", { path: "many.txt", maxLines: 20 }, idleSignal, noop, {
      cwd: dir,
    });
    const details = readDetails(result);
    // Without an explicit page the read returns the LAST page.
    assert.match(text(result), /Showing lines 81-100 of 100 \(page 5\/5\)/u);
    assert.equal(details.window.anchors.length, 20);
    assert.equal(details.window.startLine, 81);
    assert.equal(result.details?.maxLines, 20);
    assert.equal(result.details?.maxBytes, DEFAULT_READ_MAX_BYTES);
    assert.equal(result.details?.page, 5);
    assert.equal(result.details?.totalPages, 5);

    const head = await read.execute(
      "c-head",
      { path: "many.txt", maxLines: 20, page: 1 },
      idleSignal,
      noop,
      {
        cwd: dir,
      },
    );
    assert.match(text(head), /Showing lines 1-20 of 100 \(page 1\/5\)/u);
    assert.equal(readDetails(head).window.startLine, 1);
  });
});

test("read rejects invalid maxBytes, maxLines, and page overrides", async () => {
  await withTempDir(async (dir) => {
    const read = createReadToolConfig();
    await writeFile(join(dir, "valid.txt"), "ok\n", "utf-8");

    const badBytes = await read.execute("c", { path: "valid.txt", maxBytes: 0 }, idleSignal, noop, {
      cwd: dir,
    });
    assert.equal(badBytes.isError, true);
    assert.equal(badBytes.details?.code, "INVALID_READ_WINDOW");
    assert.equal(badBytes.details?.parameter, "maxBytes");

    const badLines = await read.execute(
      "c",
      { path: "valid.txt", maxLines: -1 },
      idleSignal,
      noop,
      { cwd: dir },
    );
    assert.equal(badLines.isError, true);
    assert.equal(badLines.details?.code, "INVALID_READ_WINDOW");
    assert.equal(badLines.details?.parameter, "maxLines");

    const badPage = await read.execute("c", { path: "valid.txt", page: 0 }, idleSignal, noop, {
      cwd: dir,
    });
    assert.equal(badPage.isError, true);
    assert.equal(badPage.details?.code, "INVALID_READ_WINDOW");
    assert.equal(badPage.details?.parameter, "page");
  });
});

test("read small files return full content with the default caps", async () => {
  await withTempDir(async (dir) => {
    const read = createReadToolConfig();
    await writeFile(join(dir, "small.txt"), "one\ntwo\n", "utf-8");

    const result = await read.execute("c", { path: "small.txt" }, idleSignal, noop, { cwd: dir });
    assert.equal(
      (result.details?.truncation as { truncated?: boolean } | undefined)?.truncated,
      undefined,
    );
    assert.equal(result.details?.maxBytes, DEFAULT_READ_MAX_BYTES);
    assert.equal(result.details?.maxLines, DEFAULT_READ_MAX_LINES);
    assert.deepEqual(
      readDetails(result).window.anchors.map((anchor) => anchor.text),
      // Trailing newline yields a trailing empty anchor per the established
      // CR/CRLF contract (see the CR-only line-ending test above).
      ["one", "two", ""],
    );
  });
});

test("write creates parent directories with a create-only precondition", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const result = await write.execute(
      "c",
      { path: "nested/deep/out.txt", content: "hello", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(result), /Successfully wrote 5 bytes/);
    assert.equal(await readFile(join(dir, "nested/deep/out.txt"), "utf-8"), "hello");
    assert.equal(result.details?.atomic, true);
    const version = String(result.details?.version);
    assert.match(version, /^sha256:[0-9a-f]{64}$/u);
    assert.match(text(result), new RegExp(`\\[File version: ${version}\\]`, "u"));
  });
});

test("write atomically replaces an existing file and preserves its mode", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const path = join(dir, "atomic.txt");
    await writeFile(path, "before", "utf-8");
    await chmod(path, 0o600);
    const before = await stat(path);
    const snapshot = await read.execute(
      "read-before-write",
      { path: "atomic.txt" },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );

    const result = await write.execute(
      "c",
      {
        path: "atomic.txt",
        content: "after",
        expectedVersion: readDetails(snapshot).version,
      },
      undefined,
      noop,
      { cwd: dir },
    );
    const after = await stat(path);
    assert.equal(result.isError ?? false, false);
    assert.notEqual(after.ino, before.ino);
    assert.equal(after.mode & 0o777, 0o600);
    assert.equal(await readFile(path, "utf-8"), "after");
    assert.deepEqual(await readdir(dir), ["atomic.txt"]);
  });
});

test("write refuses to replace a symbolic-link target", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const target = join(dir, "target.txt");
    const linked = join(dir, "linked.txt");
    await writeFile(target, "target content", "utf-8");
    await symlink("target.txt", linked);

    const result = await write.execute(
      "symlink-write",
      { path: "linked.txt", content: "replacement", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );

    assert.equal(result.isError, true);
    assert.match(text(result), /Refusing to atomically replace symbolic link/u);
    assert.equal((await lstat(linked)).isSymbolicLink(), true);
    assert.equal(await readFile(target, "utf-8"), "target content");
    assert.deepEqual((await readdir(dir)).sort(), ["linked.txt", "target.txt"]);
  });
});

test("atomic replacement detaches one hard-link name without mutating its sibling", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const replaced = join(dir, "replaced.txt");
    const sibling = join(dir, "sibling.txt");
    await writeFile(replaced, "shared inode", "utf-8");
    await link(replaced, sibling);
    assert.equal((await stat(replaced)).ino, (await stat(sibling)).ino);
    const snapshot = await read.execute(
      "read-hard-link",
      { path: "replaced.txt" },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );

    const result = await write.execute(
      "hard-link-write",
      {
        path: "replaced.txt",
        content: "new inode",
        expectedVersion: readDetails(snapshot).version,
      },
      undefined,
      noop,
      { cwd: dir },
    );

    assert.equal(result.isError ?? false, false);
    assert.equal(await readFile(replaced, "utf-8"), "new inode");
    assert.equal(await readFile(sibling, "utf-8"), "shared inode");
    assert.notEqual((await stat(replaced)).ino, (await stat(sibling)).ino);
  });
});

test("versioned write recovers from an external conflict after refreshing the snapshot", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    const path = join(dir, "shared.txt");
    await writeFile(path, "version one", "utf-8");
    const initial = await read.execute("c", { path: "shared.txt" }, undefined, noop, {
      cwd: dir,
    });
    const expectedVersion = readDetails(initial).version;
    const guarded = await write.execute(
      "c",
      { path: "shared.txt", content: "version two", expectedVersion },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(guarded.isError ?? false, false);
    assert.equal(guarded.details?.previousVersion, expectedVersion);
    const guardedVersion = String(guarded.details?.version);
    await writeFile(path, "external update", "utf-8");

    const blindAttempt = await write.execute(
      "blind-overwrite",
      { path: "shared.txt", content: "blind overwrite" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(blindAttempt.isError, true);
    assert.equal(blindAttempt.details?.code, "INVALID_EXPECTED_VERSION");
    assert.equal(await readFile(path, "utf-8"), "external update");

    const result = await write.execute(
      "c",
      { path: "shared.txt", content: "stale update", expectedVersion: guardedVersion },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError, true);
    assert.equal(result.details?.code, "VERSION_CONFLICT");
    assert.equal(result.details?.expectedVersion, guardedVersion);
    assert.notEqual(result.details?.actualVersion, guardedVersion);
    assert.equal(result.details?.retry, "read_then_retry");
    assert.equal(await readFile(path, "utf-8"), "external update");

    const refreshed = await read.execute("refresh", { path: "shared.txt" }, undefined, noop, {
      cwd: dir,
    });
    const refreshedVersion = readDetails(refreshed).version;
    assert.equal(result.details?.actualVersion, refreshedVersion);
    assert.deepEqual(
      readDetails(refreshed).window.anchors.map((anchor) => anchor.text),
      ["external update"],
    );

    const retry = await write.execute(
      "retry",
      { path: "shared.txt", content: "recovered update", expectedVersion: refreshedVersion },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(retry.isError ?? false, false);
    assert.equal(retry.details?.previousVersion, refreshedVersion);
    assert.equal(await readFile(path, "utf-8"), "recovered update");

    const final = await read.execute("verify", { path: "shared.txt" }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(readDetails(final).version, retry.details?.version);
    assert.deepEqual(
      readDetails(final).window.anchors.map((anchor) => anchor.text),
      ["recovered update"],
    );
  });
});

test("write supports create-only expectedVersion for new files", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const created = await write.execute(
      "c",
      { path: "new.txt", content: "first", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(created.isError ?? false, false);
    assert.equal(created.details?.previousVersion, "missing");

    const conflict = await write.execute(
      "c",
      { path: "new.txt", content: "second", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(conflict.isError, true);
    assert.equal(conflict.details?.code, "VERSION_CONFLICT");
    assert.equal(await readFile(join(dir, "new.txt"), "utf-8"), "first");
  });
});

test("concurrent create-only writes commit exactly one file", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const results = await Promise.all(
      ["alpha", "beta"].map((content, index) =>
        write.execute(
          `create-only-${index}`,
          { path: "exclusive.txt", content, expectedVersion: "missing" },
          undefined,
          noop,
          { cwd: dir },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    const conflict = results.find((result) => result.isError === true);
    assert.equal(conflict?.details?.code, "VERSION_CONFLICT");
    assert.match(await readFile(join(dir, "exclusive.txt"), "utf-8"), /^(alpha|beta)$/u);
    assert.deepEqual(await readdir(dir), ["exclusive.txt"]);
  });
});

test("concurrent writes with one expectedVersion commit exactly one replacement", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    await writeFile(join(dir, "contended.txt"), "initial", "utf-8");
    const snapshot = await read.execute(
      "read-contended",
      { path: "contended.txt" },
      undefined,
      noop,
      { cwd: dir },
    );
    const expectedVersion = readDetails(snapshot).version;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        write.execute(
          `contended-${index}`,
          { path: "contended.txt", content: `writer-${index}`, expectedVersion },
          undefined,
          noop,
          { cwd: dir },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    assert.equal(
      results.filter((result) => result.details?.code === "VERSION_CONFLICT").length,
      19,
    );
    assert.match(await readFile(join(dir, "contended.txt"), "utf-8"), /^writer-\d+$/u);
    assert.deepEqual(await readdir(dir), ["contended.txt"]);
  });
});

test("concurrent writes through a symlinked parent share one version lock", async () => {
  await withTempDir(async (dir) => {
    const tools = collectTools(piFilesExtension);
    const read = tools.get("read")!;
    const write = tools.get("write")!;
    await mkdir(join(dir, "real"));
    await symlink("real", join(dir, "alias"));
    await writeFile(join(dir, "real", "shared.txt"), "initial", "utf-8");
    const snapshot = await read.execute(
      "read-aliased",
      { path: "real/shared.txt" },
      undefined,
      noop,
      { cwd: dir },
    );
    const expectedVersion = readDetails(snapshot).version;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        write.execute(
          `aliased-${index}`,
          {
            path: `${index % 2 === 0 ? "real" : "alias"}/shared.txt`,
            content: `writer-${index}`,
            expectedVersion,
          },
          undefined,
          noop,
          { cwd: dir },
        ),
      ),
    );

    assert.equal(results.filter((result) => result.isError !== true).length, 1);
    assert.equal(
      results.filter((result) => result.details?.code === "VERSION_CONFLICT").length,
      19,
    );
  });
});

test("a queued write can be aborted without blocking the path mutex", async () => {
  await withTempDir(async (dir) => {
    const write = collectTools(piFilesExtension).get("write")!;
    const first = write.execute(
      "first-queued-write",
      { path: "abortable.txt", content: "first", expectedVersion: "missing" },
      undefined,
      noop,
      { cwd: dir },
    );
    const controller = new AbortController();
    const aborted = write.execute(
      "aborted-queued-write",
      { path: "abortable.txt", content: "must not commit", expectedVersion: "missing" },
      controller.signal,
      noop,
      { cwd: dir },
    );
    controller.abort();

    const [firstResult, abortedResult] = await Promise.all([first, aborted]);
    assert.equal(firstResult.isError ?? false, false);
    assert.equal(abortedResult.isError, true);
    assert.match(text(abortedResult), /Operation aborted/u);
    assert.equal(await readFile(join(dir, "abortable.txt"), "utf-8"), "first");
    assert.deepEqual(await readdir(dir), ["abortable.txt"]);
  });
});

test("edit applies multiple disjoint replacements and emits a diff", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    await writeFile(join(dir, "code.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n", "utf-8");
    const result = await edit.execute(
      "c",
      {
        path: "code.ts",
        edits: [
          { oldText: "const a = 1;", newText: "const a = 10;" },
          { oldText: "const c = 3;", newText: "const c = 30;" },
        ],
      },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError ?? false, false);
    assert.match(text(result), /Successfully replaced 2 block\(s\) in code\.ts/);
    assert.equal(
      await readFile(join(dir, "code.ts"), "utf-8"),
      "const a = 10;\nconst b = 2;\nconst c = 30;\n",
    );
    assert.equal(typeof result.details?.diff, "string");
    assert.equal(typeof result.details?.patch, "string");
  });
});

test("edit rejects a direct symbolic-link target before reading it", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    const target = join(dir, "edit-target.txt");
    const linked = join(dir, "edit-linked.txt");
    await writeFile(target, "original", "utf-8");
    await symlink("edit-target.txt", linked);

    const result = await edit.execute(
      "edit-symlink",
      { path: "edit-linked.txt", edits: [{ oldText: "original", newText: "changed" }] },
      undefined,
      noop,
      { cwd: dir },
    );

    assert.equal(result.isError, true);
    assert.match(text(result), /Refusing to atomically replace symbolic link/u);
    assert.equal(await readFile(target, "utf-8"), "original");
    assert.equal((await lstat(linked)).isSymbolicLink(), true);
  });
});

test("edit rejects duplicate, missing, and overlapping edits", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    await writeFile(join(dir, "dup.txt"), "x\nx\n", "utf-8");
    const dup = await edit.execute(
      "c",
      { path: "dup.txt", edits: [{ oldText: "x", newText: "y" }] },
      undefined,
      noop,
      {
        cwd: dir,
      },
    );
    assert.equal(dup.isError, true);
    assert.match(text(dup), /occurrences/);

    await writeFile(join(dir, "one.txt"), "alpha beta gamma\n", "utf-8");
    const missing = await edit.execute(
      "c",
      { path: "one.txt", edits: [{ oldText: "nope", newText: "x" }] },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(missing.isError, true);
    assert.match(text(missing), /Could not find/);

    const overlap = await edit.execute(
      "c",
      {
        path: "one.txt",
        edits: [
          { oldText: "alpha beta", newText: "A" },
          { oldText: "beta gamma", newText: "B" },
        ],
      },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(overlap.isError, true);
    assert.match(text(overlap), /overlap/);
  });
});

test("edit fuzzy-matches smart quotes and trailing whitespace", async () => {
  await withTempDir(async (dir) => {
    const edit = collectTools(piFilesExtension).get("edit")!;
    await writeFile(join(dir, "smart.txt"), "say \u201Chello\u201D now   \n", "utf-8");
    const result = await edit.execute(
      "c",
      { path: "smart.txt", edits: [{ oldText: 'say "hello" now', newText: "done" }] },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.equal(result.isError ?? false, false);
    assert.match(await readFile(join(dir, "smart.txt"), "utf-8"), /done/);
  });
});

test("ls lists alphabetically with directory suffixes", async () => {
  await withTempDir(async (dir) => {
    const ls = collectTools((api) => registerSparkFilesTools(api, { tools: ["ls"] })).get("ls")!;
    await mkdir(join(dir, "subdir"));
    await writeFile(join(dir, "b.txt"), "", "utf-8");
    await writeFile(join(dir, "a.txt"), "", "utf-8");
    const result = await ls.execute("c", {}, undefined, noop, { cwd: dir });
    assert.deepEqual(text(result).split("\n"), ["a.txt", "b.txt", "subdir/"]);
  });
});

test("ls summarizes large directories when shorter", async () => {
  await withTempDir(async (dir) => {
    const ls = collectTools((api) => registerSparkFilesTools(api, { tools: ["ls"] })).get("ls")!;
    await mkdir(join(dir, "many"));
    for (let i = 0; i < 35; i += 1) {
      await writeFile(
        join(dir, "many", `very-long-file-name-${String(i).padStart(2, "0")}.txt`),
        "",
        "utf-8",
      );
    }

    const result = await ls.execute("c", { path: "many" }, undefined, noop, { cwd: dir });
    assert.equal(result.details?.grouped, "summary");
    assert.match(text(result), /entries=35 dirs=0 files=35/);
    assert.match(text(result), /very-long-file-name-00\.txt/);
    assert.match(text(result), /\+23 more/);
  });
});

test("grep returns path:line: matches and respects .gitignore", async () => {
  await withTempDir(async (dir) => {
    const grep = collectTools(piFilesExtension).get("grep")!;
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n", "utf-8");
    await writeFile(join(dir, "keep.txt"), "needle here\nother\n", "utf-8");
    await writeFile(join(dir, "ignored.txt"), "needle ignored\n", "utf-8");
    const result = await grep.execute("c", { pattern: "needle" }, undefined, noop, { cwd: dir });
    assert.match(text(result), /keep\.txt:1: needle here/);
    assert.doesNotMatch(text(result), /ignored\.txt/);
  });
});

test("grep groups large same-file match output with per-file overflow", async () => {
  await withTempDir(async (dir) => {
    const grep = collectTools(piFilesExtension).get("grep")!;
    await writeFile(
      join(dir, "long-match-file.txt"),
      Array.from({ length: 12 }, (_, i) => `needle ${i + 1}`).join("\n"),
      "utf-8",
    );

    const result = await grep.execute("c", { pattern: "needle", limit: 20 }, undefined, noop, {
      cwd: dir,
    });
    assert.equal(result.details?.grouped, "by_file");
    assert.match(text(result), /long-match-file\.txt \(12\)/);
    assert.match(text(result), /  long-match-file\.txt:1: needle 1/);
    assert.match(text(result), /\+4 more in long-match-file\.txt/);
  });
});

test("grep supports literal mode, context lines, and no-match", async () => {
  await withTempDir(async (dir) => {
    const grep = collectTools(piFilesExtension).get("grep")!;
    await writeFile(join(dir, "f.txt"), "a\nb.c\nd\n", "utf-8");
    const literal = await grep.execute(
      "c",
      { pattern: "b.c", literal: true, context: 1 },
      undefined,
      noop,
      { cwd: dir },
    );
    assert.match(text(literal), /f\.txt:2: b\.c/);
    assert.match(text(literal), /f\.txt-1- a/);
    assert.match(text(literal), /f\.txt-3- d/);

    const none = await grep.execute("c", { pattern: "zzz" }, undefined, noop, { cwd: dir });
    assert.equal(text(none), "No matches found");
  });
});

test("find groups large results by directory when shorter", async () => {
  await withTempDir(async (dir) => {
    const find = collectTools(piFilesExtension).get("find")!;
    await mkdir(join(dir, "src"));
    for (let i = 0; i < 12; i += 1) {
      await writeFile(join(dir, "src", `long-file-name-${i}.ts`), "", "utf-8");
    }

    const result = await find.execute("c", { pattern: "*.ts" }, undefined, noop, { cwd: dir });
    assert.equal(result.details?.grouped, "by_directory");
    assert.match(text(result), /src\/ \(12\)/);
    assert.match(text(result), /long-file-name-0\.ts/);
    assert.match(text(result), /\+6 more/);
  });
});

test("find matches globs over a gitignore-aware walk", async () => {
  await withTempDir(async (dir) => {
    const find = collectTools(piFilesExtension).get("find")!;
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src/a.ts"), "", "utf-8");
    await writeFile(join(dir, "src/b.js"), "", "utf-8");
    await writeFile(join(dir, "node_modules/dep.ts"), "", "utf-8");

    const ts = await find.execute("c", { pattern: "*.ts" }, undefined, noop, { cwd: dir });
    assert.match(text(ts), /src\/a\.ts/);
    assert.doesNotMatch(text(ts), /node_modules/);
    assert.doesNotMatch(text(ts), /b\.js/);

    const none = await find.execute("c", { pattern: "*.md" }, undefined, noop, { cwd: dir });
    assert.equal(text(none), "No files found matching pattern");
  });
});

test("walkTree skips node_modules/.git and honors limit", async () => {
  await withTempDir(async (dir) => {
    // Directory names alone drive the hard skips; avoid writing under `.git/`
    // (some environments refuse opens inside any `.git` path).
    await mkdir(join(dir, ".git"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules/x.js"), "", "utf-8");
    await writeFile(join(dir, "one.txt"), "", "utf-8");
    await writeFile(join(dir, "two.txt"), "", "utf-8");
    const collected: string[] = [];
    for await (const entry of walkTree(dir)) collected.push(entry.relativePath);
    assert.deepEqual(collected.sort(), ["one.txt", "two.txt"]);
  });
});

test("truncateHead reports first-line-exceeds-limit", () => {
  const big = "x".repeat(DEFAULT_MAX_BYTES + 10);
  const result = truncateHead(big);
  assert.equal(result.firstLineExceedsLimit, true);
  assert.equal(result.content, "");
});

test("truncateHead preserves CR-only and mixed separators", () => {
  assert.deepEqual(truncateHead("one\rtwo\rthree", { maxLines: 2 }), {
    content: "one\rtwo",
    truncated: true,
    truncatedBy: "lines",
    totalLines: 3,
    totalBytes: 13,
    outputLines: 2,
    outputBytes: 7,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: 2,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  assert.equal(
    truncateHead("one\r\ntwo\rthree\nfour", { maxLines: 3 }).content,
    "one\r\ntwo\rthree",
  );
});

test("truncateLine caps long lines", () => {
  const { text: capped, wasTruncated } = truncateLine("y".repeat(600));
  assert.equal(wasTruncated, true);
  assert.match(capped, /\.\.\. \[truncated\]$/);
});

test("applyEditsToNormalizedContent + generateDiffString produce a line-numbered diff", () => {
  const { baseContent, newContent } = applyEditsToNormalizedContent(
    "a\nb\nc\n",
    [{ oldText: "b", newText: "B" }],
    "x.txt",
  );
  const { diff, firstChangedLine } = generateDiffString(baseContent, newContent);
  assert.equal(firstChangedLine, 2);
  assert.match(diff, /-2 b/);
  assert.match(diff, /\+2 B/);
});
