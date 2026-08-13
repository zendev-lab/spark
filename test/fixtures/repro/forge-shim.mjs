#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const ledgerPath = process.env.SPARK_REPRO_FORGE_LEDGER?.trim();
if (!ledgerPath) fail("SPARK_REPRO_FORGE_LEDGER is required");
const argv = process.argv.slice(2);
const ledger = readLedger();

if (argv[0] === "stack" && argv[1] === "init") {
  const base = option("--base") ?? "main";
  const branch = argv.at(-1);
  if (!branch || branch.startsWith("--")) fail("gh stack init requires a branch");
  git(["switch", "-c", branch]);
  ledger.trunk = base;
  ledger.branches = [{ name: branch, base }];
  ledger.events.push({ type: "stack.init", branch, base });
  persist();
  process.stdout.write(`Initialized ${branch}\n`);
  process.exit(0);
}

if (argv[0] === "stack" && argv[1] === "view" && argv.includes("--json")) {
  const branch = currentBranch();
  const branches =
    ledger.branches.length > 0 ? ledger.branches : [{ name: branch, base: ledger.trunk }];
  process.stdout.write(
    `${JSON.stringify({
      trunk: ledger.trunk,
      currentBranch: branch,
      stackNumber: 1,
      branches: branches.map((entry) => ({
        ...entry,
        isCurrent: entry.name === branch,
        isMerged: false,
        isQueued: false,
        needsRebase: false,
      })),
    })}\n`,
  );
  process.exit(0);
}

if (argv[0] === "stack" && argv[1] === "submit") {
  const ready = argv.includes("--open");
  const branch = currentBranch();
  if (!ledger.pullRequest) {
    ledger.pullRequest = {
      number: 1,
      title: "Fix minimal normalization alignment",
      state: "OPEN",
      url: "https://github.invalid/acme/minimal-alignment/pull/1",
      body: "Deterministic Golden Journey Draft PR",
      labels: [],
      headRefName: branch,
      baseRefName: ledger.trunk,
      headRepositoryOwner: { login: "acme" },
      isCrossRepository: false,
      isDraft: !ready,
      statusCheckRollup: [{ name: "journey", state: "SUCCESS" }],
    };
    if (ready) ledger.nonDraftPrCreates += 1;
    else ledger.draftPrCreates += 1;
  }
  ledger.events.push({ type: "stack.submit", branch, ready });
  persist();
  process.stdout.write(`${ledger.pullRequest.url}\n`);
  process.exit(0);
}

if (argv[0] === "pr" && argv[1] === "list") {
  const head = option("--head");
  const pullRequests =
    ledger.pullRequest && (!head || ledger.pullRequest.headRefName === head)
      ? [ledger.pullRequest]
      : [];
  process.stdout.write(`${JSON.stringify(pullRequests)}\n`);
  process.exit(0);
}

fail(`unsupported deterministic gh command: ${argv.join(" ")}`);

function option(name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function currentBranch() {
  return git(["branch", "--show-current"]).trim();
}

function git(args) {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" });
}

function readLedger() {
  return JSON.parse(readFileSync(ledgerPath, "utf8"));
}

function persist() {
  const temporary = `${ledgerPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, ledgerPath);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
