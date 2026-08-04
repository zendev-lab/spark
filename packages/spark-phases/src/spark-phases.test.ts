import assert from "node:assert/strict";
import { test } from "vitest";
import {
  BUILTIN_PHASES,
  PHASE_TOOL_STATUS_ACTION,
  assemblePhaseSystemPrompt,
  composeAgentSystemPrompt,
  createPhaseRegistry,
  createPhaseTool,
  normalizePhaseToolAction,
  renderPhaseMarker,
  resolveActivePhase,
  runPhaseToolAction,
  type PhaseDefinition,
} from "./index.ts";

function builtinDefinitions(): PhaseDefinition[] {
  return BUILTIN_PHASES.map((id) => ({
    id,
    title: id[0].toUpperCase() + id.slice(1),
    builtin: true,
    renderRequirements: (context) =>
      `## ${id} requirements${context.focus ? `\n- focus=${context.focus}` : ""}`,
  }));
}

test("phase registry is ordered and open", () => {
  const registry = createPhaseRegistry({ definitions: builtinDefinitions() });
  registry.register({ id: "audit", title: "Audit", renderRequirements: () => "audit" });
  assert.deepEqual(registry.ids(), ["plan", "implement", "audit"]);
  assert.deepEqual(registry.builtinIds(), ["plan", "implement"]);
  assert.throws(() => registry.require("missing"), /unknown phase/u);
});

test("active phase uses explicit, suggested, then fallback precedence", () => {
  const registry = createPhaseRegistry({ definitions: builtinDefinitions() });
  assert.deepEqual(
    resolveActivePhase({ registry, explicitSelection: "plan", suggest: "implement" }),
    { phase: "plan", source: "explicit" },
  );
  assert.deepEqual(resolveActivePhase({ registry, suggest: "implement" }), {
    phase: "implement",
    source: "suggested",
  });
  assert.deepEqual(resolveActivePhase({ registry }), { phase: "plan", source: "fallback" });
});

test("phase action tool validates, reports, and switches", () => {
  const registry = createPhaseRegistry({ definitions: builtinDefinitions() });
  const tool = createPhaseTool({ registry });
  assert.equal(tool.name, "phase");
  assert.equal(normalizePhaseToolAction(undefined, registry), PHASE_TOOL_STATUS_ACTION);
  assert.throws(() => normalizePhaseToolAction("bogus", registry), /phase action/u);
  const result = runPhaseToolAction({
    action: "implement",
    registry,
    currentPhase: "plan",
    context: { focus: "ship" },
  });
  assert.equal(result.phase, "implement");
  assert.match(result.text, /focus=ship/u);
});

test("phase marker is orthogonal to loop activity", () => {
  assert.equal(renderPhaseMarker({ phase: "plan" }), undefined);
  assert.equal(renderPhaseMarker({ phase: "implement" }), "Phase: implement.");
  assert.equal(renderPhaseMarker({ phase: "plan", loopActive: true }), "Loop active.");
});

test("phase prompt composition drops empty sections", () => {
  const registry = createPhaseRegistry({ definitions: builtinDefinitions() });
  assert.equal(
    composeAgentSystemPrompt(["identity", "", undefined, "surface"]),
    "identity\n\nsurface",
  );
  assert.equal(
    assemblePhaseSystemPrompt({
      basePrompt: "BASE",
      registry,
      phase: "plan",
      context: {},
      marker: "Phase: plan.",
    }),
    "BASE\n\nPhase: plan.\n\n## plan requirements",
  );
});
