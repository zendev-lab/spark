import assert from "node:assert/strict";
import { test } from "vitest";
import { validateGitHubWorkflow } from "../scripts/check-github-actions.mjs";

test("CI workflows accept pull requests and merge groups without push", () => {
  const workflow = `name: CI

on:
  pull_request:
  merge_group:
    types:
      - checks_requested

permissions:
  contents: read

jobs: {}
`;

  assert.deepEqual(validateGitHubWorkflow(workflow, ".github/workflows/ci-tests.yml"), []);
});

test("CI workflows reject main push alongside pull requests", () => {
  const workflow = `name: CI

on:
  push:
    branches:
      - main
  pull_request:

jobs: {}
`;

  assert.deepEqual(validateGitHubWorkflow(workflow, ".github/workflows/ci-tests.yml"), [
    ".github/workflows/ci-tests.yml: CI workflows must not run on push",
  ]);
});

test("CI workflows reject inline push and require pull requests", () => {
  assert.deepEqual(validateGitHubWorkflow("name: CI\non: [push]\njobs: {}\n", "ci-smoke.yml"), [
    "ci-smoke.yml: CI workflows must retain the pull_request trigger",
    "ci-smoke.yml: CI workflows must not run on push",
  ]);
});

test("non-CI workflows may retain push triggers", () => {
  const workflow = `name: CD

on:
  push:
    branches:
      - main

jobs: {}
`;

  assert.deepEqual(validateGitHubWorkflow(workflow, ".github/workflows/cd-publish.yml"), []);
});

test("a CI job named push is not mistaken for a workflow trigger", () => {
  const workflow = `name: CI

on: pull_request

jobs:
  push:
    runs-on: ubuntu-latest
    steps: []
`;

  assert.deepEqual(validateGitHubWorkflow(workflow, ".github/workflows/ci-tests.yml"), []);
});
