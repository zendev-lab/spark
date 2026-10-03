import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);
const root = resolve(".");

test("source-distributed spark-hub is the canonical executable surface", async () => {
  const { stdout, stderr } = await execFileAsync(
    resolve(root, "apps/spark-hub/bin/spark-hub"),
    ["--help"],
    { cwd: root, env: process.env },
  );

  assert.match(stdout, /spark-hub - Spark control plane and embedded management UI/u);
  assert.match(stdout, /spark-hub web <start\|status\|stop\|logs>/u);
  assert.match(stdout, /"spark hub \.\.\." dispatcher form forwards/u);
  assert.doesNotMatch(stdout, /spark hub access create/u);
  assert.equal(stderr, "");
}, 30_000);
