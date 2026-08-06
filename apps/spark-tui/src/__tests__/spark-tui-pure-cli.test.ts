import assert from "node:assert/strict";
import { test } from "vitest";

import { parseSparkCliCommand } from "../cli.ts";

test("spark-tui rejects the removed server route with Hub guidance", () => {
  assert.deepEqual(parseSparkCliCommand(["server", "task", "list"]), {
    kind: "error",
    message: '"server" is not a spark-tui command. Use "spark hub" instead.',
  });
  assert.deepEqual(parseSparkCliCommand(["server", "instance", "status"]), {
    kind: "error",
    message: '"server" is not a spark-tui command. Use "spark hub" instead.',
  });
});

test("spark-tui rejects daemon commands owned by spark-daemon", () => {
  assert.deepEqual(parseSparkCliCommand(["daemon", "restart"]), {
    kind: "error",
    message: '"daemon" is not a spark-tui command. Use "spark daemon ..." instead.',
  });
  assert.deepEqual(parseSparkCliCommand(["daemon", "--help"]), {
    kind: "error",
    message: '"daemon" is not a spark-tui command. Use "spark daemon ..." instead.',
  });
});
