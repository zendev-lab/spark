import assert from "node:assert/strict";
import { test } from "vitest";
import type { GitChangeArtifactBody, GitChangeEntry } from "../artifact/index.ts";
import { gitChangeReviewState } from "./review-state.ts";

function body(
  entries: GitChangeEntry[],
  lifecycle: GitChangeArtifactBody["lifecycle"] = "published",
): GitChangeArtifactBody {
  return {
    schemaVersion: 2,
    kind: "git_change",
    repository: { forge: "github", repo: "zendev-lab/spark" },
    trunk: "main",
    worktree: { ownership: "spark", status: "attached", path: "/tmp/worktree" },
    stack: { authority: "gh-stack", entries },
    lifecycle,
  };
}

function entry(
  branch: string,
  input: { draft?: boolean; state?: string; merged?: boolean; published?: boolean } = {},
): GitChangeEntry {
  return {
    branch,
    base: "main",
    isCurrent: false,
    isMerged: input.merged === true,
    isQueued: false,
    needsRebase: false,
    ...(input.published === false
      ? {}
      : {
          pullRequest: {
            forge: "github",
            repo: "zendev-lab/spark",
            number: branch.length,
            url: `https://github.com/zendev-lab/spark/pull/${branch.length}`,
            state: input.state ?? "open",
            title: branch,
            headRef: branch,
            baseRef: "main",
            ...(input.draft === undefined ? {} : { draft: input.draft }),
          },
        }),
  };
}

test("gitChangeReviewState distinguishes unpublished, draft, and ready stacks", () => {
  assert.equal(gitChangeReviewState(body([])), "unpublished");
  assert.equal(
    gitChangeReviewState(
      body([entry("one", { published: false }), entry("two", { published: false })]),
    ),
    "unpublished",
  );
  assert.equal(
    gitChangeReviewState(body([entry("one", { draft: true }), entry("two", { draft: true })])),
    "draft",
  );
  assert.equal(
    gitChangeReviewState(body([entry("one", { draft: false }), entry("two", { draft: false })])),
    "ready",
  );
});

test("gitChangeReviewState is mixed for partial publication or inconsistent draft state", () => {
  assert.equal(
    gitChangeReviewState(body([entry("one", { draft: true }), entry("two", { published: false })])),
    "mixed",
  );
  assert.equal(
    gitChangeReviewState(body([entry("one", { draft: true }), entry("two", { draft: false })])),
    "mixed",
  );
  assert.equal(gitChangeReviewState(body([entry("one"), entry("two", { draft: false })])), "mixed");
});

test("gitChangeReviewState ignores terminal layers and recognizes terminal lifecycle", () => {
  assert.equal(
    gitChangeReviewState(
      body([
        entry("merged", { merged: true, state: "merged", draft: false }),
        entry("open", { draft: false }),
      ]),
    ),
    "ready",
  );
  assert.equal(
    gitChangeReviewState(body([entry("closed", { state: "closed", draft: false })])),
    "terminal",
  );
  assert.equal(
    gitChangeReviewState(body([entry("open", { draft: true })], "terminal")),
    "terminal",
  );
  assert.equal(gitChangeReviewState(body([entry("open", { draft: true })], "cleaned")), "terminal");
});
