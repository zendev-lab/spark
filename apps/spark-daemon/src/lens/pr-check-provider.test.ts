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

  const missing = await runGitHubPrChecks("/workspace", undefined, fixtureRunner({ checks: [] }));
  expect(missing.verdict).toBe("inconclusive");
  expect(missing.message).toMatch(/No required PR checks/u);
});

function fixtureRunner(
  options: { status?: string; remoteHead?: string; checks?: unknown[] } = {},
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
        }),
        stderr: "",
      };
    }
    if (operation.startsWith("gh pr checks")) {
      return {
        code: 0,
        stdout: JSON.stringify(
          options.checks ?? [
            {
              name: "required",
              state: "SUCCESS",
              bucket: "pass",
              workflow: "CI",
            },
          ],
        ),
        stderr: "",
      };
    }
    throw new Error(`unexpected command: ${operation}`);
  };
}
