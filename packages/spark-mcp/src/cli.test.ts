import assert from "node:assert/strict";
import { test } from "vitest";

import { classifySparkMcpArgs } from "../bin/spark-mcp.ts";

test("classifySparkMcpArgs treats help flags as help", () => {
  assert.deepEqual(classifySparkMcpArgs(["--help"]), { kind: "help" });
  assert.deepEqual(classifySparkMcpArgs(["-h"]), { kind: "help" });
  assert.deepEqual(classifySparkMcpArgs(["foo", "--help"]), { kind: "help" });
});

test("classifySparkMcpArgs starts with empty argv and rejects unknown arguments", () => {
  assert.deepEqual(classifySparkMcpArgs([]), { kind: "start" });
  assert.deepEqual(classifySparkMcpArgs(["--unknown"]), {
    kind: "unknown",
    argument: "--unknown",
  });
});
