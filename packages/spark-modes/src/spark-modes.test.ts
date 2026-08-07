import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BUILTIN_MODES,
  MODE_TOOL_STATUS_ACTION,
  assembleModeSystemPrompt,
  composeAgentSystemPrompt,
  createModeRegistry,
  createModeTool,
  normalizeModeToolAction,
  renderModeMarker,
  resolveActiveMode,
  runModeToolAction,
  type ModeDefinition,
} from "./index.ts";

function builtinDefinitions(): ModeDefinition[] {
  return BUILTIN_MODES.map((id) => ({
    id,
    title: id[0].toUpperCase() + id.slice(1),
    builtin: true,
    renderRequirements: (context) =>
      `## ${id} requirements${context.focus ? `\n- focus=${context.focus}` : ""}`,
  }));
}

test("mode registry is ordered and open", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  registry.register({ id: "audit", title: "Audit", renderRequirements: () => "audit" });
  assert.deepEqual(registry.ids(), ["plan", "execute", "audit"]);
  assert.deepEqual(registry.builtinIds(), ["plan", "execute"]);
  assert.throws(() => registry.require("missing"), /unknown mode/u);
});

test("active mode uses explicit, suggested, then fallback precedence", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.deepEqual(resolveActiveMode({ registry, explicitSelection: "plan", suggest: "execute" }), {
    mode: "plan",
    source: "explicit",
  });
  assert.deepEqual(resolveActiveMode({ registry, suggest: "execute" }), {
    mode: "execute",
    source: "suggested",
  });
  assert.deepEqual(resolveActiveMode({ registry }), { mode: "plan", source: "fallback" });
});

test("mode action tool validates, reports, and switches", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  const tool = createModeTool({ registry });
  assert.equal(tool.name, "mode");
  assert.equal(normalizeModeToolAction(undefined, registry), MODE_TOOL_STATUS_ACTION);
  assert.throws(() => normalizeModeToolAction("bogus", registry), /mode action/u);
  const result = runModeToolAction({
    action: "execute",
    registry,
    currentMode: "plan",
    context: { focus: "ship" },
  });
  assert.equal(result.mode, "execute");
  assert.match(result.text, /focus=ship/u);
});

test("mode marker is orthogonal to loop activity", () => {
  assert.equal(renderModeMarker({ mode: "plan" }), undefined);
  assert.equal(renderModeMarker({ mode: "execute" }), "Mode: execute.");
  assert.equal(renderModeMarker({ mode: "plan", loopActive: true }), "Loop active.");
});

test("mode prompt composition drops empty sections", () => {
  const registry = createModeRegistry({ definitions: builtinDefinitions() });
  assert.equal(
    composeAgentSystemPrompt(["identity", "", undefined, "surface"]),
    "identity\n\nsurface",
  );
  assert.equal(
    assembleModeSystemPrompt({
      basePrompt: "BASE",
      registry,
      mode: "plan",
      context: {},
      marker: "Mode: plan.",
    }),
    "BASE\n\nMode: plan.\n\n## plan requirements",
  );
});
