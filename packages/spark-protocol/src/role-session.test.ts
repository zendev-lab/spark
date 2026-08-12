import { describe, expect, it } from "vitest";
import { parseSparkRoleSpec, sparkRoleModelTypeSchema } from "./role-session.ts";

const role = {
  ref: "role:builtin-explorer",
  id: "explorer",
  source: "builtin",
  revision: 1,
  description: "Inspect local state.",
  systemPrompt: "Inspect the repository without mutating it.",
  capabilities: ["read", "exec"],
  allowedTools: ["read", "cue_exec"],
  modelType: "exploration",
  instantiation: "owned",
  origin: { kind: "builtin" },
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
} as const;

describe("role session protocol", () => {
  it("round-trips one canonical RoleSpec and preserves extension fields", () => {
    expect(parseSparkRoleSpec({ ...role, extensionMetadata: { provider: "test" } })).toEqual({
      ...role,
      extensionMetadata: { provider: "test" },
    });
  });

  it("accepts open semantic Model Types without imposing a rank vocabulary", () => {
    expect(sparkRoleModelTypeSchema.parse("local_gpu_review")).toBe("local_gpu_review");
    expect(() => sparkRoleModelTypeSchema.parse("Tier 1")).toThrow();
  });

  it("rejects incomplete and contradictory RoleSpecs", () => {
    expect(() => parseSparkRoleSpec({ ...role, revision: 0 })).toThrow();
    expect(() => parseSparkRoleSpec({ ...role, capabilities: ["read", "read"] })).toThrow(
      /unique/u,
    );
    expect(() => parseSparkRoleSpec({ ...role, modelType: "" })).toThrow();
  });
});
