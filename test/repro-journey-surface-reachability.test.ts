import assert from "node:assert/strict";
import { describe, test } from "vitest";

import { parseSparkInteractionRequest } from "@zendev-lab/spark-protocol";

import { parseHumanQuestions } from "../apps/spark-hub/src/lib/pending-ask.ts";
import { askFlowRequestFromInteraction } from "@zendev-lab/spark-ask";

describe("Repro Journey Ask surface reachability", () => {
  test("Hub and native Ask overlay preserve one canonical decision schema", () => {
    const interaction = parseSparkInteractionRequest({
      requestId: "ask_flow:repro-golden-journey-repair",
      kind: "askFlow",
      title: "Approve localized target repair",
      prompt: "The immutable target fixture fails before the localized repair.",
      flow: "repro-golden-journey-repair",
      delivery: "blocking",
      mode: "decision",
      questions: [
        {
          id: "decision",
          prompt: "Apply the localized normalization repair to the target implementation?",
          type: "single",
          required: true,
          defaultValues: [],
          options: [
            { value: "approve", label: "Approve repair" },
            { value: "stop", label: "Stop" },
          ],
        },
      ],
    });
    assert.equal(interaction.kind, "askFlow");
    if (interaction.kind !== "askFlow") throw new Error("expected askFlow interaction");

    const nativeRequest = askFlowRequestFromInteraction(interaction);
    const hubQuestions = parseHumanQuestions(JSON.stringify(interaction.questions));
    assert.deepEqual(
      nativeRequest.questions.map(({ id, type, options }) => ({ id, type, options })),
      hubQuestions.map(({ id, type, options }) => ({ id, type, options })),
    );
  });
});
