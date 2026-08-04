import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);

test("spark-hub is the canonical executable surface", async () => {
  const executable = fileURLToPath(new URL("../../bin/spark-hub", import.meta.url));
  const { stdout, stderr } = await execFileAsync(executable, ["--help"]);

  assert.match(stdout, /spark-hub - Spark control plane and embedded management UI/u);
  assert.equal(stderr, "");
});
