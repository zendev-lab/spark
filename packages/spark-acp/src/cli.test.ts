import assert from "node:assert/strict";
import { test } from "vitest";

import { classifySparkAcpArgs } from "../bin/spark-acp.ts";

test("classifySparkAcpArgs treats help flags as help and everything else as start", () => {
  assert.deepEqual(classifySparkAcpArgs(["--help"]), { kind: "help" });
  assert.deepEqual(classifySparkAcpArgs(["-h"]), { kind: "help" });
  assert.deepEqual(classifySparkAcpArgs([]), { kind: "start" });
  assert.deepEqual(classifySparkAcpArgs(["--unknown"]), { kind: "start" });
});
