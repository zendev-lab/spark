import { describe, expect, it } from "vitest";

import type { ArtifactRef } from "@zendev-lab/spark-core";
import { bindSparkReproFormalizeOwnership, createSparkSessionRepro } from "@zendev-lab/spark-repro";

import { requireFormalizeIntegrator } from "./spark-repro-three-lane-composition.ts";

describe("Repro Formalize writer authorization", () => {
  it("allows only the integrator Session for the current ownership generation", () => {
    const state = bindSparkReproFormalizeOwnership(
      createSparkSessionRepro("session:root").threeLane,
      {
        gitChangeRef: "artifact:canonical" as ArtifactRef,
        integratorSessionId: "session:integrator",
        generation: 1,
      },
    );

    expect(() => requireFormalizeIntegrator(state, "session:integrator")).not.toThrow();
    expect(() => requireFormalizeIntegrator(state, "session:other-worker")).toThrow(
      "only the bound stack integrator",
    );
  });
});
