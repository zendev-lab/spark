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
            instruction: "run owned role",
            status: "failed",
            sessionLifetime: "owned",
          },
          stdout: "",
          stderr: "owned role failed",
          jsonEvents: [],
        },
      }),
    ).toMatchObject({
      executorKind: "daemon-native",
      sessionLifetime: "owned",
    });
  });
});
