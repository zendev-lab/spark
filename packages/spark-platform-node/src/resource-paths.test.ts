import { describe, expect, it } from "vitest";
import { orderedSparkResourceRoots, sparkResourceLayerOrder } from "./resource-paths.ts";

describe("Spark resource precedence", () => {
  it("keeps one order for every resource owner", () => {
    expect(sparkResourceLayerOrder).toEqual([
      "builtin",
      "user",
      "workspace",
      "cwd",
      "configured",
      "repository",
    ]);
    expect(
      orderedSparkResourceRoots({
        repository: ["repo"],
        user: ["user"],
        builtin: ["builtin"],
        configured: ["configured"],
        cwd: ["cwd"],
        workspace: ["workspace"],
      }),
    ).toEqual([
      { layer: "builtin", path: "builtin" },
      { layer: "user", path: "user" },
      { layer: "workspace", path: "workspace" },
      { layer: "cwd", path: "cwd" },
      { layer: "configured", path: "configured" },
      { layer: "repository", path: "repo" },
    ]);
  });
});
