import { describe, expect, it } from "vitest";
import type { SparkModelControlSnapshot } from "@zendev-lab/spark-protocol";
import { adaptLegacyDaemonModelControlSnapshot } from "./hub-runtime-model-channel-client";

const firstModel = { providerName: "openai", modelId: "gpt-5" };
const secondModel = { providerName: "openai", modelId: "gpt-5-mini" };

function snapshot(
  scopedModels?: SparkModelControlSnapshot["scopedModels"],
): SparkModelControlSnapshot {
  return {
    providers: [
      {
        providerName: "openai",
        label: "OpenAI",
        auth: { providerName: "openai", kind: "api_key", configured: true },
        models: [
          {
            model: firstModel,
            reasoning: true,
            input: ["text"],
            available: true,
          },
          {
            model: secondModel,
            reasoning: true,
            input: ["text"],
            available: false,
          },
        ],
      },
    ],
    diagnostics: [],
    ...(scopedModels === undefined ? {} : { scopedModels }),
  };
}

describe("Hub runtime model channel compatibility", () => {
  it("projects the full catalog as scope for an older daemon snapshot", () => {
    expect(adaptLegacyDaemonModelControlSnapshot(snapshot()).scopedModels).toEqual([
      firstModel,
      secondModel,
    ]);
  });

  it("preserves the current daemon's explicit scope, including an empty scope", () => {
    const explicit = snapshot([secondModel]);
    const empty = snapshot([]);

    expect(adaptLegacyDaemonModelControlSnapshot(explicit)).toBe(explicit);
    expect(adaptLegacyDaemonModelControlSnapshot(empty)).toBe(empty);
  });
});
