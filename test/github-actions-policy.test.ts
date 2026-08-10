import assert from "node:assert/strict";
import { test } from "vitest";

import { validateGitHubWorkflow } from "../scripts/check-github-actions.mjs";

test("GitHub Actions policy accepts immutable and local action references", () => {
  assert.deepEqual(
    validateGitHubWorkflow(`
jobs:
  test:
    steps:
      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567
      - uses: ./actions/local
`),
    [],
  );
});

test("GitHub Actions policy rejects mutable remote action references", () => {
  assert.deepEqual(validateGitHubWorkflow("steps:\n  - uses: actions/checkout@v7\n"), [
    "workflow.yml: remote action actions/checkout@v7 must use a complete commit SHA",
  ]);
});

test("benchmark workflow policy rejects credentials while allowing read-only execution", () => {
  const safe = `permissions:\n  contents: read\nsteps:\n  - run: pnpm run bench\n`;
  assert.deepEqual(validateGitHubWorkflow(safe, "ci-benchmarks.yml"), []);

  const violations = validateGitHubWorkflow(
    `${safe}  - run: echo \${{ secrets.CODSPEED_TOKEN }}\n  token: value\n`,
    "ci-benchmarks.yml",
  );
  assert.equal(violations.length, 2);
  assert.match(violations.join("\n"), /must not read repository secrets/u);
  assert.match(violations.join("\n"), /must not request token/u);
});

test("PR workflow policy requires centralized validators and merge-queue coverage", () => {
  const safe = `
on:
  pull_request:
  merge_group:
jobs:
  title:
    if: github.event.pull_request.user.login != 'renovate[bot]'
    steps:
      - uses: zendev-lab/zendev/actions/validate-title@0123456789abcdef0123456789abcdef01234567
      - uses: zendev-lab/zendev/actions/validate-body@abcdef0123456789abcdef0123456789abcdef01
`;
  assert.deepEqual(validateGitHubWorkflow(safe, "ci-pr-checks.yml"), []);

  const violations = validateGitHubWorkflow(
    "on:\n  pull_request:\njobs:\n  check:\n    steps:\n      - run: node scripts/validate-pr-title.mjs\n",
    "ci-pr-checks.yml",
  );
  assert.equal(violations.length, 5);
  assert.match(violations.join("\n"), /pinned zendev validate-title/u);
  assert.match(violations.join("\n"), /pinned zendev validate-body/u);
  assert.match(violations.join("\n"), /repository-local validator/u);
  assert.match(violations.join("\n"), /merge queue/u);
  assert.match(violations.join("\n"), /Renovate exemption/u);
});
