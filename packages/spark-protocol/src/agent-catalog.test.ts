import { describe, expect, it } from "vitest";

import { sparkRoleCreateRequestSchema, sparkRoleModelSetRequestSchema } from "./agent-catalog.ts";

describe("Role and Skill catalog contract", () => {
  it("accepts bounded project Role proposals and rejects unsafe ids", () => {
    expect(
      sparkRoleCreateRequestSchema.parse({
        workspaceId: "workspace-1",
        id: "web-reviewer",
        description: "Review Web owner boundaries",
        systemPrompt: "Verify the implementation.",
        capabilities: ["read"],
        modelType: "verification",
      }),
    ).toMatchObject({ id: "web-reviewer", capabilities: ["read"] });
    expect(() =>
      sparkRoleCreateRequestSchema.parse({
        workspaceId: "workspace-1",
        id: "../../escape",
        description: "unsafe",
        systemPrompt: "unsafe",
        modelType: "custom",
      }),
    ).toThrow();
  });
  it("keeps Role model mutations scoped and provider-qualified", () => {
    expect(
      sparkRoleModelSetRequestSchema.parse({
        workspaceId: "workspace-1",
        roleRef: "role:project-reviewer",
        model: "test/reviewer",
      }),
    ).toEqual({
      workspaceId: "workspace-1",
      roleRef: "role:project-reviewer",
      model: "test/reviewer",
      source: "project",
    });
    expect(() =>
      sparkRoleModelSetRequestSchema.parse({
        workspaceId: "workspace-1",
        roleRef: "role:project-reviewer",
        model: "reviewer",
      }),
    ).toThrow();
  });
});
