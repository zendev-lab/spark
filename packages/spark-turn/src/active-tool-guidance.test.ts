import assert from "node:assert/strict";
import { test } from "vitest";
import type { ToolConfig } from "@zendev-lab/spark-core";
import {
  activeToolGuidanceFingerprintInput,
  renderActiveToolGuidance,
} from "./active-tool-guidance.ts";
import type { SparkTurnRegisteredTool } from "./turn-types.ts";

function registered(name: string, promptGuidelines?: string[]): SparkTurnRegisteredTool {
  const config: ToolConfig = {
    name,
    label: name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
    ...(promptGuidelines ? { promptGuidelines } : {}),
  };
  return { config, active: true };
}

test("renderActiveToolGuidance renders one deterministic section for the supplied active set", () => {
  const output = renderActiveToolGuidance([
    registered("read", ["Read before editing.", "Read before editing.", "  "]),
    registered("git", ["Refresh native PR state after publication."]),
    registered("plain"),
  ]);

  assert.equal(
    output,
    [
      "## Active tool guidance",
      "",
      "### read",
      "- Read before editing.",
      "",
      "### git",
      "- Refresh native PR state after publication.",
    ].join("\n"),
  );
  assert.deepEqual(activeToolGuidanceFingerprintInput(registered("read", [" A ", "A", "B"])), [
    "A",
    "B",
  ]);
});

test("renderActiveToolGuidance omits an empty active set", () => {
  assert.equal(renderActiveToolGuidance([registered("plain")]), undefined);
});
