import { describe, expect, it } from "vitest";

import {
  SPARK_DAEMON_LOG_LINES_DEFAULT,
  sparkDaemonLogsRequestSchema,
  sparkSessionExportRequestSchema,
  sparkSessionSearchRequestSchema,
  sparkWorkspaceDirectoryListRequestSchema,
} from "./web-workbench-control.ts";

describe("Spark Web workbench owner contracts", () => {
  it("keeps directory navigation relative and bounded", () => {
    expect(
      sparkWorkspaceDirectoryListRequestSchema.parse({ workspaceId: "workspace-1" }),
    ).toMatchObject({ relativePath: "", includeHidden: false, limit: 200 });
    expect(() =>
      sparkWorkspaceDirectoryListRequestSchema.parse({
        workspaceId: "workspace-1",
        relativePath: "/etc",
      }),
    ).toThrow(/relative/u);
    expect(() =>
      sparkWorkspaceDirectoryListRequestSchema.parse({
        workspaceId: "workspace-1",
        relativePath: "..\\escape",
      }),
    ).toThrow(/forward slashes/u);
  });

  it("bounds history searches and revision-stable export pages", () => {
    expect(
      sparkSessionSearchRequestSchema.parse({ sessionId: "session-1", query: "owner" }),
    ).toMatchObject({ limit: 50 });
    expect(
      sparkSessionExportRequestSchema.parse({ sessionId: "session-1", format: "html" }),
    ).toMatchObject({ offset: 0, limit: 50 });
    expect(() =>
      sparkSessionExportRequestSchema.parse({
        sessionId: "session-1",
        format: "html",
        revision: "not-a-revision",
      }),
    ).toThrow();
  });

  it("defaults log diagnostics to the public 100-line boundary", () => {
    expect(sparkDaemonLogsRequestSchema.parse({})).toEqual({
      lines: SPARK_DAEMON_LOG_LINES_DEFAULT,
    });
    expect(() => sparkDaemonLogsRequestSchema.parse({ lines: 501 })).toThrow();
  });
});
