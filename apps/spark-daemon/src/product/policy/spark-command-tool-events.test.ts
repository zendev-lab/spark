import assert from "node:assert/strict";
import { test } from "vitest";

import { isGoalToolDeactivationEvent } from "./spark-command-tool-events.ts";

test("goal completion is a successful deactivation event", () => {
  assert.equal(
    isGoalToolDeactivationEvent({
      toolName: "goal",
      isError: false,
      params: { action: "complete" },
    }),
    true,
  );
});
