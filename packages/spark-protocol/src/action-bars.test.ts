import { describe, expect, it } from "vitest";
import {
  parseSparkSlashInput,
  resolveSparkSlashEditorInput,
  sparkActionBarViewSchema,
  sparkActionViewSchema,
  sparkSlashActionBarCatalog,
  sparkSlashActionBarForInput,
  sparkSlashCommandDescriptors,
} from "./action-bars.ts";

describe("Spark action-bar protocol", () => {
  it("derives the compatible lookup catalog from unique canonical commands and aliases", () => {
    expect(sparkSlashCommandDescriptors.map((descriptor) => descriptor.name)).toEqual([
      "model",
      "thinking",
      "settings",
      "status",
      "queue",
      "scoped-models",
      "goal",
      "loop",
      "repro",
      "workflow",
      "help",
      "hotkeys",
    ]);

    const lookupNames = sparkSlashCommandDescriptors.flatMap((descriptor) => [
      descriptor.name,
      ...descriptor.aliases,
    ]);
    expect(new Set(lookupNames).size).toBe(lookupNames.length);
    expect(Object.keys(sparkSlashActionBarCatalog)).toEqual(lookupNames);

    for (const descriptor of sparkSlashCommandDescriptors) {
      expect(descriptor.discoverableAliases).toEqual(
        descriptor.discoverableAliases.filter((alias) => descriptor.aliases.includes(alias)),
      );
      expect(sparkSlashActionBarCatalog[descriptor.name]).toBe(descriptor.actionBar);
      for (const alias of descriptor.aliases) {
        expect(sparkSlashActionBarCatalog[alias]).toBe(descriptor.actionBar);
      }

      const serialized = JSON.stringify(descriptor.actionBar);
      expect(sparkActionBarViewSchema.parse(JSON.parse(serialized))).toEqual(descriptor.actionBar);
      expect(serialized).not.toMatch(/"(?:slash|cli|command)"\s*:/u);
      expect(serialized).not.toContain("spark tui");
      expect(serialized).not.toContain("spark daemon");
      expect(serialized).not.toContain("spark hub");
    }
  });

  it("offers canonical commands for an empty query and deterministic prefix matches", () => {
    const all = resolveSparkSlashEditorInput("/");
    expect(all.kind).toBe("suggest");
    if (all.kind !== "suggest") throw new Error("Expected slash suggestions");
    expect(all.suggestions.map((suggestion) => suggestion.command)).toEqual(
      sparkSlashCommandDescriptors.map((descriptor) => descriptor.name),
    );
    expect(
      all.suggestions.every(
        (suggestion) => !suggestion.descriptor.aliases.includes(suggestion.command),
      ),
    ).toBe(true);

    const canonicalPrefix = resolveSparkSlashEditorInput("/SE");
    expect(canonicalPrefix).toMatchObject({
      kind: "suggest",
      query: "se",
      suggestions: [{ command: "settings", canonicalCommand: "settings" }],
    });

    const mixedPrefix = resolveSparkSlashEditorInput("/r");
    expect(mixedPrefix).toMatchObject({
      kind: "suggest",
      query: "r",
      suggestions: [{ command: "repro", canonicalCommand: "repro" }],
    });
    expect(resolveSparkSlashEditorInput("/workflow-")).toEqual({
      kind: "unknown",
      command: "workflow-",
    });
  });

  it("hands exact canonical names and aliases to their action bar before prefix completion", () => {
    const canonical = resolveSparkSlashEditorInput(" /MODEL ");
    expect(canonical).toMatchObject({
      kind: "exact",
      command: "model",
      descriptor: { name: "model", actionBar: { id: "model" } },
    });

    const alias = resolveSparkSlashEditorInput("/run");
    expect(alias).toMatchObject({
      kind: "exact",
      command: "run",
      descriptor: { name: "workflow", actionBar: { id: "workflow" } },
    });
    expect(resolveSparkSlashEditorInput("/NEW")).toEqual({
      kind: "unknown",
      command: "new",
    });
  });

  it("separates ordinary text, escaped text, unknown names, and command arguments", () => {
    expect(resolveSparkSlashEditorInput("ordinary prompt")).toEqual({ kind: "inactive" });
    expect(resolveSparkSlashEditorInput("//model")).toEqual({ kind: "inactive" });
    expect(resolveSparkSlashEditorInput("please /model")).toEqual({ kind: "inactive" });
    expect(resolveSparkSlashEditorInput("/not-a-command")).toEqual({
      kind: "unknown",
      command: "not-a-command",
    });
    expect(resolveSparkSlashEditorInput("/model OpenAI/GPT-5")).toMatchObject({
      kind: "arguments",
      command: "model",
      args: "OpenAI/GPT-5",
      descriptor: { name: "model" },
    });
    expect(resolveSparkSlashEditorInput("/not-a-command value")).toEqual({
      kind: "arguments",
      command: "not-a-command",
      args: "value",
    });
  });

  it("uses semantic intents and payloads instead of executable text", () => {
    const thinking = sparkSlashActionBarForInput("/thinking");
    expect(thinking?.actions.map((action) => action.intent)).toEqual([
      "thinking.select",
      "thinking.select",
      "thinking.select",
      "thinking.select",
      "thinking.select",
      "thinking.select",
    ]);
    expect(thinking?.actions.at(-1)?.payload).toEqual({ thinkingLevel: "xhigh" });
    expect(thinking?.actions.filter((action) => action.tone === "primary")).toEqual([
      expect.objectContaining({ id: "thinking-high", payload: { thinkingLevel: "high" } }),
    ]);
    expect(sparkSlashActionBarForInput("/queue")?.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ intent: "queue.inspect" }),
        expect.objectContaining({ intent: "turn.stop", tone: "danger" }),
        expect.objectContaining({ intent: "turn.retry" }),
      ]),
    );
  });

  it("does not synthesize action bars for direct session lifecycle commands", () => {
    expect(sparkSlashActionBarForInput("/session")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/sessions")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/resume")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/new")).toBeUndefined();
  });

  it("publishes lifecycle controls and workflow run actions as typed intents", () => {
    for (const resource of ["goal", "loop", "repro"] as const) {
      expect(sparkSlashActionBarForInput(`/${resource}`)?.actions).toEqual([
        expect.objectContaining({ intent: `${resource}.status`, tone: "primary" }),
        expect.objectContaining({ intent: `${resource}.start` }),
        expect.objectContaining({ intent: `${resource}.restart` }),
        expect.objectContaining({ intent: `${resource}.stop`, tone: "danger" }),
      ]);
    }
    expect(
      sparkSlashActionBarForInput("/workflow-runs")?.actions.map((action) => action.intent),
    ).toEqual(["workflow.open", "workflow.inspect"]);

    const workflow = sparkSlashActionBarForInput("/workflow");
    expect(sparkSlashActionBarForInput("/workflow-runs")).toBe(workflow);
    expect(sparkSlashActionBarForInput("/runs")).toBe(workflow);
    expect(sparkSlashActionBarForInput("/run")).toBe(workflow);
    expect(sparkSlashActionBarForInput("/workflows")).toBe(workflow);
  });

  it("only opens a catalog bar for an exact argument-free slash command", () => {
    expect(sparkSlashActionBarForInput(" /MODEL \n")?.id).toBe("model");
    expect(sparkSlashActionBarForInput("/new")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/workflow")?.id).toBe("workflow");
    expect(sparkSlashActionBarForInput("/workflow-runs")?.id).toBe("workflow");
    expect(sparkSlashActionBarForInput("/runs")?.id).toBe("workflow");
    expect(sparkSlashActionBarForInput("/run")?.id).toBe("workflow");
    expect(sparkSlashActionBarForInput("/workflows")?.id).toBe("workflow");
    expect(sparkSlashActionBarForInput("/model openai/gpt-5")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/settings set thinking high")).toBeUndefined();
    expect(sparkSlashActionBarForInput("//model")).toBeUndefined();
    expect(sparkSlashActionBarForInput("please /model")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/unknown")).toBeUndefined();
    expect(sparkSlashActionBarForInput("/")).toBeUndefined();
  });

  it("parses names and arguments without assigning an execution target", () => {
    expect(parseSparkSlashInput(" /workflow:review   run:123 ")).toEqual({
      command: "workflow:review",
      args: "run:123",
    });
    expect(parseSparkSlashInput("/scoped-models")).toEqual({
      command: "scoped-models",
      args: "",
    });
    expect(parseSparkSlashInput("//escaped")).toBeUndefined();
  });

  it("rejects unknown descriptor fields, non-JSON payloads, and duplicate action ids", () => {
    expect(
      sparkActionViewSchema.safeParse({
        id: "model",
        label: "Model",
        intent: "model.select",
        payload: {},
        slash: "/model",
      }).success,
    ).toBe(false);
    expect(
      sparkActionViewSchema.safeParse({
        id: "model",
        label: "Model",
        intent: "model.select",
        payload: { callback: () => undefined },
      }).success,
    ).toBe(false);
    expect(
      sparkActionBarViewSchema.safeParse({
        id: "duplicate",
        title: "Duplicate",
        actions: [
          { id: "same", label: "First", intent: "status.inspect", payload: {} },
          { id: "same", label: "Second", intent: "queue.inspect", payload: {} },
        ],
      }).success,
    ).toBe(false);
  });
});
