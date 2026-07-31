import { describe, expect, test } from "vitest";

import { DaemonLensDocumentMirrors } from "./document-mirror.ts";

describe("DaemonLensDocumentMirrors", () => {
  test("isolates identical URIs across worktrees and rejects stale versions", () => {
    const mirrors = new DaemonLensDocumentMirrors();
    mirrors.sync({
      worktreeRoot: "/worktrees/a",
      uri: "file:///src/index.ts",
      languageId: "typescript",
      version: 1,
      content: "export const value = 'a';",
    });
    mirrors.sync({
      worktreeRoot: "/worktrees/b",
      uri: "file:///src/index.ts",
      languageId: "typescript",
      version: 1,
      content: "export const value = 'b';",
    });

    expect(mirrors.get("/worktrees/a", "file:///src/index.ts")?.content).toContain("'a'");
    expect(mirrors.get("/worktrees/b", "file:///src/index.ts")?.content).toContain("'b'");
    expect(() =>
      mirrors.sync({
        worktreeRoot: "/worktrees/a",
        uri: "file:///src/index.ts",
        languageId: "typescript",
        version: 1,
        content: "stale",
      }),
    ).toThrow(/stale document version/);
  });
});
