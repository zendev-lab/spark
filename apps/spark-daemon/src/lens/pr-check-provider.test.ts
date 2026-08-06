import { expect, test } from "vitest";

import { runGitHubPrChecks, type PrCheckCommandRunner } from "./pr-check-provider.ts";

test("PR checks pass only for a clean worktree, matching head, and explicit required checks", async () => {
  const report = await runGitHubPrChecks("/workspace", undefined, fixtureRunner());

  expect(report.verdict).toBe("pass");
  expect(report.localHeadOid).toBe("head-1");
  expect(report.remoteHeadOid).toBe("head-1");
  expect(report.checks).toHaveLength(1);
});

test("PR checks fail closed for uncommitted content and missing required checks", async () => {
  const dirty = await runGitHubPrChecks(
    "/workspace",
    undefined,
    fixtureRunner({ status: " M value.ts\n" }),
  );
  expect(dirty.verdict).toBe("stale");

  const missing = await runGitHubPrChecks(
    "/workspace",
    undefined,
    fixtureRunner({ requiredChecks: [] }),
  );
  expect(missing.verdict).toBe("inconclusive");
  expect(missing.message).toMatch(/No required PR checks/u);
});

test("merged PRs fall back to their complete recorded check set", async () => {
  const report = await runGitHubPrChecks(
    "/workspace",
    undefined,
    fixtureRunner({
      state: "MERGED",
      requiredChecks: [],
      requiredCode: 1,
      requiredStderr: "no required checks reported",
      recordedChecks: [
        { name: "required", state: "SUCCESS", bucket: "pass", workflow: "CI" },
        { name: "smoke", state: "SUCCESS", bucket: "pass", workflow: "CI" },
      ],
    }),
  );

  expect(report.verdict).toBe("pass");
  expect(report.checks).toHaveLength(2);
  expect(report.message).toMatch(/All merged PR checks passed/u);
});

test("merged PR recorded checks remain fail-closed", async () => {
  const failed = await runGitHubPrChecks(
    "/workspace",
    undefined,
    fixtureRunner({
      state: "MERGED",
      requiredChecks: [],
      recordedChecks: [{ name: "smoke", state: "FAILURE", bucket: "fail" }],
    }),
  );
  expect(failed.verdict).toBe("fail");

  const missing = await runGitHubPrChecks(
    "/workspace",
    undefined,
    fixtureRunner({ state: "MERGED", requiredChecks: [], recordedChecks: [] }),
  );
  expect(missing.verdict).toBe("inconclusive");
  expect(missing.message).toMatch(/No checks were recorded/u);
});

function fixtureRunner(
  options: {
    status?: string;
    remoteHead?: string;
    state?: string;
    requiredChecks?: unknown[];
    requiredCode?: number;
    requiredStderr?: string;
    recordedChecks?: unknown[];
  } = {},
): PrCheckCommandRunner {
  return async (command, args) => {
    const operation = `${command} ${args.join(" ")}`;
    if (operation === "git rev-parse HEAD") {
      return { code: 0, stdout: "head-1\n", stderr: "" };
    }
    if (operation === "git status --porcelain --untracked-files=normal") {
      return { code: 0, stdout: options.status ?? "", stderr: "" };
    }
    if (operation.startsWith("gh pr view")) {
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 42,
          url: "https://github.com/acme/repo/pull/42",
          headRefOid: options.remoteHead ?? "head-1",
          isDraft: true,
          state: options.state ?? "OPEN",
        }),
        stderr: "",
      };
    }
    if (operation.startsWith("gh pr checks")) {
      const required = operation.includes(" --required ");
      return {
        code: required ? (options.requiredCode ?? 0) : 0,
        stdout: JSON.stringify(
          required
            ? (options.requiredChecks ?? [
                {
                  name: "required",
                  state: "SUCCESS",
                  bucket: "pass",
                  workflow: "CI",
                },
              ])
            : (options.recordedChecks ?? []),
        ),
        stderr: required ? (options.requiredStderr ?? "") : "",
      };
    }
    throw new Error(`unexpected command: ${operation}`);
  };
}
