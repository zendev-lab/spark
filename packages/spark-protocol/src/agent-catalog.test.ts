import { describe, expect, it } from "vitest";

import { sparkRoleCreateRequestSchema, sparkSkillGetResultSchema } from "./agent-catalog.ts";

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

  it("returns Skill content without a host filesystem path", () => {
    const result = sparkSkillGetResultSchema.parse({
      workspaceId: "workspace-1",
      skill: {
        name: "browser-check",
        description: "Verify a browser surface",
        layer: "cwd",
        disableModelInvocation: false,
        content: "---\nname: browser-check\n---\n",
      },
    });
    expect(result.skill).not.toHaveProperty("filePath");
    expect(result.skill).not.toHaveProperty("baseDir");
  });
});
