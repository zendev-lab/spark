import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { registerWorkspace } from "../store/workspaces.ts";
import { invokeLocalRpcService } from "./service.ts";

describe("daemon-owned tool execution", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the reported Pi line window through the real service boundary", async () => {
    const { paths, db, cwd, workspaceId } = createFixture();
    const lines = Array.from({ length: 900 }, (_, index) => `line-${index + 1}`);
    writeFileSync(join(cwd, "large.txt"), lines.join("\n"), "utf8");

    const result = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "read",
        toolCallId: "read-window-500-679",
        operationId: "test:file:read-window-500-679",
        params: { path: "large.txt", offset: 500, limit: 180 },
        hostContext: {
          workspaceId,
          sessionSource: "tui",
          sessionSurface: "local",
        },
      },
      { paths, db },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toMatch(/500#[0-9a-f]{12}:line-500/u);
    expect(result.content[0]?.text).toMatch(/679#[0-9a-f]{12}:line-679/u);
    expect(result.details).toMatchObject({
      totalLines: 900,
      window: {
        startLine: 500,
        endLine: 679,
        nextOffset: 680,
        requestedLimit: 180,
      },
    });
    db.close();
  });

  it("preserves versioned write and stale-CAS failure semantics through the daemon", async () => {
    const { paths, db, cwd, workspaceId } = createFixture();
    const hostContext = {
      workspaceId,
      sessionSource: "tui" as const,
      sessionSurface: "local" as const,
    };

    const created = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "write",
        toolCallId: "write-create",
        operationId: "test:file:write-create",
        params: { path: "note.md", content: "version one\n", expectedVersion: "missing" },
        hostContext,
      },
      { paths, db },
    );
    expect(created.isError).not.toBe(true);

    const read = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "read",
        toolCallId: "read-version",
        operationId: "test:file:read-version",
        params: { path: "note.md" },
        hostContext,
      },
      { paths, db },
    );
    const version = read.details?.version;
    expect(version).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const updated = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "write",
        toolCallId: "write-update",
        operationId: "test:file:write-update",
        params: { path: "note.md", content: "version two\n", expectedVersion: version },
        hostContext,
      },
      { paths, db },
    );
    expect(updated.isError).not.toBe(true);

    const stale = await invokeLocalRpcService(
      "file.execute",
      {
        cwd,
        tool: "write",
        toolCallId: "write-stale",
        operationId: "test:file:write-stale",
        params: { path: "note.md", content: "stale overwrite\n", expectedVersion: version },
        hostContext,
      },
      { paths, db },
    );
    expect(stale).toMatchObject({
      isError: true,
      details: { code: "VERSION_CONFLICT", retry: "read_then_retry" },
    });
    db.close();
  });

  it("returns an actionable tool result instead of Internal Server Error for stale cwd", async () => {
    const { paths, db, cwd, workspaceId } = createFixture();
    const staleCwd = join(cwd, "removed-worktree");

    const result = await invokeLocalRpcService(
      "file.execute",
      {
        cwd: staleCwd,
        tool: "read",
        toolCallId: "read-stale-cwd",
        operationId: "test:file:read-stale-cwd",
        params: { path: "package.json", offset: 500, limit: 180 },
        hostContext: {
          workspaceId,
          sessionSource: "tui",
          sessionSurface: "local",
        },
      },
      { paths, db },
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        code: "WORKSPACE_CWD_INVALID",
        retry: "rebind_workspace_cwd",
        cwd: staleCwd,
        workspaceId,
      },
    });
    expect(result.content[0]?.text).toContain("Reopen or rebind the session");
    expect(result.content[0]?.text).not.toContain("Internal Server Error");
    db.close();
  });

  it("fails closed with a structured result when an operation id is reused with new input", async () => {
    const { paths, db, cwd, workspaceId } = createFixture();
    writeFileSync(join(cwd, "one.txt"), "one\n", "utf8");
    writeFileSync(join(cwd, "two.txt"), "two\n", "utf8");
    const common = {
      cwd,
      tool: "read" as const,
      toolCallId: "read-reused-id",
      operationId: "test:file:reused-operation",
      hostContext: {
        workspaceId,
        sessionSource: "tui" as const,
        sessionSurface: "local" as const,
      },
    };

    const first = await invokeLocalRpcService(
      "file.execute",
      { ...common, params: { path: "one.txt" } },
      { paths, db },
    );
    const replay = await invokeLocalRpcService(
      "file.execute",
      { ...common, params: { path: "one.txt" } },
      { paths, db },
    );
    const conflict = await invokeLocalRpcService(
      "file.execute",
      { ...common, params: { path: "two.txt" } },
      { paths, db },
    );

    expect(replay).toEqual(first);
    expect(conflict).toMatchObject({
      isError: true,
      details: {
        code: "TOOL_OPERATION_ID_CONFLICT",
        retry: "new_tool_call",
      },
    });
    expect(conflict.content[0]?.text).toContain("No operation was executed");
    db.close();
  });

  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "spark-tool-execution-"));
    roots.push(root);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    const cwd = join(paths.dataDir, "workspace");
    mkdirSync(cwd, { recursive: true });
    const db = openSparkDaemonDatabase(paths);
    const workspace = registerWorkspace(db, { localPath: cwd });
    return { paths, db, cwd, workspaceId: workspace.id };
  }
});
