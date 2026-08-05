import assert from "node:assert/strict";
import { test } from "vitest";

import { SparkTerminalController } from "../apps/spark-tui/src/native-tui/controller.ts";

test("SparkTerminalController keeps renderer presentation state immutable", () => {
  const controller = new SparkTerminalController();
  const initial = controller.viewState;
  const expanded = controller.dispatch({ type: "tools.toggle" });

  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(expanded), true);
  assert.equal(initial.toolsExpanded, false);
  assert.equal(expanded.toolsExpanded, true);
});

test("SparkTerminalController owns hub and transcript navigation intents", () => {
  const controller = new SparkTerminalController();

  assert.equal(
    controller.dispatch({
      type: "hub.cycle",
      panels: ["overview", "workflows", "runs"],
    }).activeHubPanel,
    "workflows",
  );
  assert.equal(
    controller.dispatch({ type: "hub.toggle", panel: "workflows" }).activeHubPanel,
    undefined,
  );
  assert.equal(
    controller.dispatch({ type: "transcript.scroll", delta: 4 }).transcriptScrollOffset,
    4,
  );
  assert.equal(
    controller.dispatch({ type: "transcript.scroll", delta: -10 }).transcriptScrollOffset,
    0,
  );
  const beforeEmptyCycle = controller.viewState;
  assert.equal(controller.dispatch({ type: "hub.cycle", panels: [] }), beforeEmptyCycle);
});
