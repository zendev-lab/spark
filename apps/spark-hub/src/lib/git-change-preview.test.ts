import { describe, expect, it } from "vitest";
import { gitChangePreviewFromContentRef } from "./git-change-preview";

describe("gitChangePreviewFromContentRef", () => {
  it("projects a canonical git_change body", () => {
    const preview = gitChangePreviewFromContentRef("git_change", {
      inlineJson: {
        schemaVersion: 2,
        kind: "git_change",
        repository: { forge: "github", repo: "zendev-lab/spark" },
        trunk: "main",
        worktree: { ownership: "spark", status: "attached", branch: "feat/ui" },
        stack: {
          authority: "gh-stack",
          number: 7,
          currentBranch: "feat/ui",
          entries: [
            {
              branch: "feat/ui",
              base: "feat/report",
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

    expect(preview).toMatchObject({
      repository: { repo: "zendev-lab/spark" },
      stack: { number: 7, entries: [{ branch: "feat/ui", base: "feat/report" }] },
    });
  });

  it("normalizes an existing v1 PR projection without replaying Spark UI", () => {
    const preview = gitChangePreviewFromContentRef("pr", {
      inlineJson: {
        schemaVersion: 1,
        kind: "pr",
        forge: "github",
        repo: "zendev-lab/spark",
        number: 135,
        url: "https://github.com/zendev-lab/spark/pull/135",
        state: "OPEN",
        title: "Add real Artifact preview",
        bodyText: "## Summary\n\nRendered **Markdown**.",
        headRef: "feat/ui",
        baseRef: "main",
        worktreeStatus: "failed",
        worktreeError: "Worktree is unavailable",
        checksSummary: "SUCCESS",
      },
    });

    expect(preview).toMatchObject({
      lifecycle: "published",
      worktree: { status: "missing", error: "Worktree is unavailable" },
      stack: {
        entries: [
          {
            pullRequest: {
              number: 135,
              checksSummary: "SUCCESS",
              bodyText: "## Summary\n\nRendered **Markdown**.",
            },
          },
        ],
      },
    });
  });

  it("rejects unrelated inline JSON", () => {
    expect(
      gitChangePreviewFromContentRef("git_change", { inlineJson: { kind: "workflow" } }),
    ).toBeNull();
  });

  it("does not render PR-shaped content under another Artifact kind", () => {
    expect(
      gitChangePreviewFromContentRef("document", {
        inlineJson: {
          schemaVersion: 1,
          kind: "pr",
          forge: "github",
          repo: "zendev-lab/spark",
          number: 135,
          url: "https://github.com/zendev-lab/spark/pull/135",
          state: "OPEN",
          title: "Wrong outer kind",
          headRef: "feat/ui",
          baseRef: "main",
        },
      }),
    ).toBeNull();
  });
});
