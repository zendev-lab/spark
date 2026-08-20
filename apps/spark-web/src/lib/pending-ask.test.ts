import assert from "node:assert/strict";
import { test } from "vitest";

import {
  encodeWebAskAnswers,
  hasEncodableWebAskAnswer,
  missingRequiredWebAskPrompts,
  parseWebAskQuestions,
  webCustomAnswerValue,
  webMultiAnswerWithCustomFallback,
  webSingleAnswerWithCustomFallback,
  webAskAnswerHasValue,
} from "./pending-ask.ts";

const single = {
  id: "scope",
  type: "single" as const,
  prompt: "Scope?",
  options: [
    { value: "mvp", label: "MVP" },
    { value: "full", label: "Full" },
  ],
};

const multi = {
  id: "surface",
  type: "multi" as const,
  prompt: "Surfaces?",
  options: [
    { value: "web", label: "Web" },
    { value: "tui", label: "TUI" },
  ],
};

test("encodes option values instead of labels", () => {
  assert.deepEqual(webSingleAnswerWithCustomFallback(single, "mvp", "ignored"), {
    values: ["mvp"],
    labels: ["MVP"],
  });
  assert.deepEqual(webSingleAnswerWithCustomFallback(single, "MVP", ""), {
    values: ["mvp"],
    labels: ["MVP"],
  });
  assert.deepEqual(webSingleAnswerWithCustomFallback(single, webCustomAnswerValue, "  custom  "), {
    values: [],
    customText: "custom",
  });
  assert.deepEqual(
    webMultiAnswerWithCustomFallback(multi, ["web", webCustomAnswerValue], "  native app  "),
    { values: ["web"], labels: ["Web"], customText: "native app" },
  );
  assert.deepEqual(webAskAnswerHasValue({ values: [], customText: "custom" }), true);
  assert.deepEqual(webAskAnswerHasValue({ values: [] }), false);
});

test("normalizes daemon wait questions without trusting malformed payloads", () => {
  assert.deepEqual(
    parseWebAskQuestions([
      {
        id: "scope",
        question: "How far?",
        multi_select: false,
        options: [
          { id: "mvp", label: "MVP", description: "Ship a slice" },
          { value: "full", label: "Full" },
        ],
      },
      { id: "notes", prompt: "Anything else?", type: "freeform", required: true },
      { prompt: "missing id" },
      null,
    ]),
    [
      {
        id: "scope",
        type: "single",
        prompt: "How far?",
        options: [
          { value: "mvp", label: "MVP", description: "Ship a slice" },
          { value: "full", label: "Full" },
        ],
      },
      { id: "notes", type: "freeform", prompt: "Anything else?", required: true },
    ],
  );
});

test("builds the durable respond payload from workbench selections", () => {
  const answers = encodeWebAskAnswers({
    questions: [single, multi, { id: "notes", type: "freeform", prompt: "Notes?" }],
    selectedByQuestionId: {
      scope: "mvp",
      surface: ["web"],
      notes: "ship web first",
    },
  });
  assert.deepEqual(answers, {
    scope: { values: ["mvp"], labels: ["MVP"] },
    surface: { values: ["web"], labels: ["Web"] },
    notes: { values: [], customText: "ship web first" },
  });
  assert.equal(hasEncodableWebAskAnswer(answers), true);
  assert.deepEqual(missingRequiredWebAskPrompts([{ ...single, required: true }], answers), []);
});

test("does not collapse a missing required option into a freeform text blob", () => {
  const answers = encodeWebAskAnswers({
    questions: [{ ...single, required: true }],
    selectedByQuestionId: {},
    fallbackMessage: "please pick later",
  });
  assert.deepEqual(answers, { scope: { values: [] } });
  assert.deepEqual(missingRequiredWebAskPrompts([{ ...single, required: true }], answers), [
    "Scope?",
  ]);
  assert.equal(hasEncodableWebAskAnswer(answers), false);
});

test("legacy waits without questions keep a message field, not a DSH-style text blob", () => {
  assert.deepEqual(
    encodeWebAskAnswers({
      questions: [],
      selectedByQuestionId: {},
      fallbackMessage: "  Continue without it  ",
    }),
    { message: "Continue without it" },
  );
});
