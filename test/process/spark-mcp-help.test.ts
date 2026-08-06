import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(".");
const helpPattern = /spark-mcp - Spark Model Context Protocol stdio adapter/u;

test("source product exposes direct and dispatcher MCP help commands", async () => {
  const direct = await execFileAsync(
    resolve(root, "packages/spark-mcp/scripts/stdio.ts"),
    ["--help"],
    {
      cwd: root,
      env: process.env,
    },
  );
  assert.match(direct.stdout, helpPattern);
  assert.equal(direct.stderr, "");

  const dispatched = await execFileAsync(
    resolve(root, "apps/spark-cli/bin/spark"),
    ["mcp", "--help"],
    {
      cwd: root,
      env: process.env,
    },
  );
  assert.match(dispatched.stdout, helpPattern);
  assert.equal(dispatched.stderr, "");
}, 30_000);
