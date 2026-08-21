import { describe, expect, it } from "vitest";

import { explicitMemoryRefs, sparkWebTurnMessageMetadata } from "./memory-feedback.ts";

describe("Spark Web memory feedback presentation", () => {
  it("shows controls only for explicit memory, recall, and learning references", () => {
    expect(
      explicitMemoryRefs([
        "Used memory:ranked and (recall:prior).",
        "A generic memory mention is not a reference; learning-fact:stable is.",
      ]),
    ).toEqual(["memory:ranked", "recall:prior", "learning-fact:stable"]);
    expect(explicitMemoryRefs(["memory and learning are ordinary words"])).toEqual([]);
  });

  it("marks turns as local Spark Web without carrying a credential", () => {
    expect(sparkWebTurnMessageMetadata()).toEqual({
      origin: { kind: "user", host: "web", surface: "local", product: "spark-web" },
    });
  });
});
