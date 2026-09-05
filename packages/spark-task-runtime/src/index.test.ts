import { describe, expect, it } from "vitest";
import { buildRoleRunFailureDiagnostic } from "./index.ts";

describe("RoleRun failure diagnostics", () => {
  it("classifies an owned Session projection as daemon-native", () => {
    expect(
      buildRoleRunFailureDiagnostic({
        result: {
          record: {
            ref: "run:owned",
            roleRef: "role:executor",
            roleRevision: `sha256:${"a".repeat(64)}`,
            instruction: "run owned role",
            status: "failed",
          },
          stdout: "",
          stderr: "owned role failed",
          jsonEvents: [],
        },
      }),
    ).toMatchObject({
      executorKind: "daemon-native",
    });
  });
});
