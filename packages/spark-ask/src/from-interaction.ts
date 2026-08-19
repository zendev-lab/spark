import type { SparkInteractionRequest, SparkJsonObject } from "@zendev-lab/spark-protocol";

import type { SparkAskFlowRequest, SparkAskFlowResult } from "./schema.ts";

/** Map a protocol askFlow interaction onto the ask overlay request contract. */
export function askFlowRequestFromInteraction(
  request: Extract<SparkInteractionRequest, { kind: "askFlow" }>,
): SparkAskFlowRequest {
  return {
    title: request.title,
    ...(request.prompt ? { context: request.prompt } : {}),
    ...(request.flow ? { flow: request.flow } : {}),
    ...(request.delivery ? { delivery: request.delivery } : {}),
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    mode: request.mode,
    questions: request.questions.map((question) => {
      // Protocol waits and live events often omit options/defaultValues. Treat
      // missing arrays as empty so a freeform or custom-only question still
      // opens the overlay instead of throwing before presentAskFlow mounts.
      const options = question.options ?? [];
      const defaultValues = question.defaultValues ?? [];
      const customOnly = question.type !== "freeform" && options.length === 0;
      return {
        id: question.id,
        prompt: question.prompt,
        ...(question.header ? { header: question.header } : {}),
        type: customOnly ? "freeform" : question.type,
        required: question.required,
        defaultValues: customOnly ? [] : [...defaultValues],
        options: options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          ...(option.preview ? { preview: option.preview } : {}),
        })),
      };
    }),
    ...(request.allowElaborate === undefined
      ? {}
      : { behaviour: { allowElaborate: request.allowElaborate } }),
  };
}

export function askFlowAnswersFromResult(result: SparkAskFlowResult): SparkJsonObject {
  return Object.fromEntries(
    Object.entries(result.answers).map(([questionId, answer]) => [
      questionId,
      {
        values: [...answer.values],
        ...(answer.labels ? { labels: [...answer.labels] } : {}),
        ...(answer.customText !== undefined ? { customText: answer.customText } : {}),
        ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
        ...(answer.preview !== undefined ? { preview: answer.preview } : {}),
      },
    ]),
  );
}
