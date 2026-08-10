#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const workflowRoot = join(repositoryRoot, ".github", "workflows");
const remoteActionPattern = /^[^@\s]+@[a-f0-9]{40}$/u;

function workflowTriggerDeclaration(source) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^(?:["']?on["']?):/u.test(line));
  if (start < 0) return "";

  const declaration = [lines[start]];
  if (!/^(?:["']?on["']?):\s*$/u.test(lines[start])) return declaration.join("\n");

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      declaration.push(line);
      continue;
    }
    if (!/^\s/u.test(line)) break;
    declaration.push(line);
  }
  return declaration.join("\n");
}

function workflowHasTrigger(source, trigger) {
  const declaration = workflowTriggerDeclaration(source);
  const escapedTrigger = trigger.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`^ {2}${escapedTrigger}:`, "mu").test(declaration) ||
    new RegExp(`^(?:["']?on["']?):\\s*${escapedTrigger}\\s*$`, "mu").test(declaration) ||
    new RegExp(`^(?:["']?on["']?):\\s*\\[[^\\]]*\\b${escapedTrigger}\\b`, "mu").test(declaration) ||
    new RegExp(`^(?:["']?on["']?):\\s*\\{[^}]*\\b${escapedTrigger}\\s*:`, "mu").test(declaration)
  );
}

export function workflowActionReferences(source) {
  return [...source.matchAll(/^\s*(?:-\s+)?uses:\s*["']?([^"'\s#]+)["']?/gmu)].map(
    (match) => match[1],
  );
}

export function validateGitHubWorkflow(source, file = "workflow.yml") {
  const violations = [];
  for (const action of workflowActionReferences(source)) {
    if (action.startsWith("./") || action.startsWith("docker://")) continue;
    if (!remoteActionPattern.test(action)) {
      violations.push(`${file}: remote action ${action} must use a complete commit SHA`);
    }
  }

  const workflowName = file.split("/").at(-1) ?? file;
  if (/^ci-.*\.ya?ml$/u.test(workflowName)) {
    if (!workflowHasTrigger(source, "pull_request")) {
      violations.push(`${file}: CI workflows must retain the pull_request trigger`);
    }
    if (workflowHasTrigger(source, "push")) {
      violations.push(`${file}: CI workflows must not run on push`);
    }
  }

  if (file.endsWith("/ci-benchmarks.yml") || file === "ci-benchmarks.yml") {
    if (!/^permissions:\s*\n\s{2}contents:\s*read\s*$/mu.test(source)) {
      violations.push(`${file}: benchmark workflow must declare read-only contents permission`);
    }
    if (/\bsecrets\s*\./u.test(source)) {
      violations.push(`${file}: benchmark workflow must not read repository secrets`);
    }
    if (/^\s+(?:id-token|token):\s*/mu.test(source)) {
      violations.push(`${file}: benchmark workflow must not request token permissions or inputs`);
    }
  }

  if (file.endsWith("/ci-pr-checks.yml") || file === "ci-pr-checks.yml") {
    const actions = workflowActionReferences(source);
    for (const validator of ["validate-title", "validate-body"]) {
      if (
        !actions.some((action) =>
          new RegExp(`^zendev-lab/zendev/actions/${validator}@[a-f0-9]{40}$`, "u").test(action),
        )
      ) {
        violations.push(`${file}: PR checks must use the pinned zendev ${validator} action`);
      }
    }
    if (/node\s+scripts\/validate-pr-(?:title|body)\.mjs/u.test(source)) {
      violations.push(`${file}: PR checks must not restore repository-local validator execution`);
    }
    if (!/^\s{2}merge_group:\s*$/mu.test(source)) {
      violations.push(`${file}: PR checks must cover the merge queue`);
    }
    if (!source.includes("renovate[bot]")) {
      violations.push(`${file}: PR checks must retain the Renovate exemption`);
    }
  }

  return violations;
}

export async function checkGitHubActions(root = workflowRoot) {
  const entries = await readdir(root, { withFileTypes: true });
  const violations = [];
  let workflowCount = 0;
  let actionCount = 0;
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !/\.ya?ml$/u.test(entry.name)) continue;
    workflowCount += 1;
    const path = join(root, entry.name);
    const source = await readFile(path, "utf8");
    actionCount += workflowActionReferences(source).length;
    violations.push(
      ...validateGitHubWorkflow(source, relative(repositoryRoot, path).replaceAll("\\", "/")),
    );
  }
  return { workflowCount, actionCount, violations };
}

async function main() {
  const result = await checkGitHubActions();
  if (result.violations.length > 0) {
    console.error("GitHub Actions policy failed:");
    for (const violation of result.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `GitHub Actions policy passed (${result.workflowCount} workflows, ${result.actionCount} immutable action references).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
