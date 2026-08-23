import { describe, expect, it } from "vitest";
import { resolveToolPolicyForArgs, type ToolConfig } from "@zendev-lab/spark-core";

describe("argument-aware tool policy", () => {
  it("resolves a concrete read action from a conservative registration envelope", () => {
    const tool = config(() => ({
      effect: "read",
      executionMode: "parallel",
      approval: "none",
    }));

    expect(resolveToolPolicyForArgs(tool, { action: "inspect" })).toEqual({
      effect: "read",
      executionMode: "parallel",
      domains: [],
      approval: "none",
    });
  });

  it.each([
    () => undefined,
    () => ({}),
    () => {
      throw new Error("bad action");
    },
  ])("fails closed when a dynamic policy cannot prove its effect", (resolvePolicy) => {
    const tool = config(resolvePolicy as NonNullable<ToolConfig["resolvePolicy"]>);

    expect(resolveToolPolicyForArgs(tool, { action: "unknown" })).toEqual({
      effect: "unknown",
      executionMode: "sequential",
      domains: [],
      approval: "required",
    });
  });
});

function config(resolvePolicy: NonNullable<ToolConfig["resolvePolicy"]>): ToolConfig {
  return {
    name: "dynamic",
    description: "dynamic policy fixture",
    parameters: {},
    policy: {
      effect: "destructive",
      executionMode: "sequential",
      approval: "required",
    },
    resolvePolicy,
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}
