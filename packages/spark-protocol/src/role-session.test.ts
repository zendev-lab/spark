import { describe, expect, it } from "vitest";
import { parseSparkRoleSpec, sparkRoleModelTypeSchema } from "./role-session.ts";

const role = {
  ref: "role:builtin-explorer",
  id: "explorer",
  source: "builtin",
  revision: `sha256:${"a".repeat(64)}`,
  description: "Inspect local state.",
  systemPrompt: "Inspect the repository without mutating it.",
  capabilities: ["read", "net"],
  allowedTools: ["read", "web"],
  modelType: "exploration",
  origin: { kind: "builtin" },
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
} as const;

describe("role session protocol", () => {
  it("round-trips one canonical RoleSpec and rejects unknown semantic fields", () => {
    expect(parseSparkRoleSpec(role)).toEqual(role);
    expect(() => parseSparkRoleSpec({ ...role, extensionMetadata: { provider: "test" } })).toThrow(
      /unrecognized_/u,
    );
    expect(() => parseSparkRoleSpec({ ...role, instantiation: "ephemeral" })).toThrow(
      /unrecognized_/u,
    );
  });

  it("accepts open semantic Model Types without imposing a rank vocabulary", () => {
    expect(sparkRoleModelTypeSchema.parse("local_gpu_review")).toBe("local_gpu_review");
    expect(() => sparkRoleModelTypeSchema.parse("Tier 1")).toThrow();
  });

  it("rejects incomplete and contradictory RoleSpecs", () => {
    expect(() => parseSparkRoleSpec({ ...role, revision: "sha256:invalid" })).toThrow();
    expect(() => parseSparkRoleSpec({ ...role, capabilities: ["read", "read"] })).toThrow(
      /unique/u,
    );
    expect(() => parseSparkRoleSpec({ ...role, modelType: "" })).toThrow();
  });
});
