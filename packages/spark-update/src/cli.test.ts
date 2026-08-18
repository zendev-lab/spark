import assert from "node:assert/strict";
import { test } from "vitest";

import { runSparkUpdateCli } from "./entry.ts";

function captureIo() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: {
        write(chunk: string) {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write(chunk: string) {
          stderr += chunk;
          return true;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("runSparkUpdateCli rejects unknown commands with exit 2", async () => {
  const capture = captureIo();
  const code = await runSparkUpdateCli(["not-a-command"], capture.io);
  assert.equal(code, 2);
  assert.ok(capture.stderr().length > 0);
});

test("runSparkUpdateCli requires --managed for install", async () => {
  const capture = captureIo();
  const code = await runSparkUpdateCli(["install"], capture.io);
  assert.equal(code, 2);
  assert.ok(capture.stderr().length > 0);
});
