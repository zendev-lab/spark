// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";

import AskQuestionField from "./AskQuestionField.svelte";
import { getDictionary } from "./i18n";
import { hubCustomAnswerValue, type PendingWorkbenchAsk } from "./pending-ask";

const messages = getDictionary("en").inboxDetail.response;
let mounted: Record<string, unknown> | undefined;

afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  document.body.replaceChildren();
});

function renderQuestion(question: PendingWorkbenchAsk["questions"][number]) {
  const target = document.createElement("div");
  document.body.append(target);
  mounted = mount(AskQuestionField, {
    target,
    props: { question, questionIndex: 0, messages },
  });
  return target;
}

const choiceQuestion = (type: "single" | "preview" | "multi") =>
  ({
    id: `${type}-choice`,
    type,
    prompt: `Choose ${type}`,
    required: true,
    options: [
      {
        value: "first",
        label: "First",
        description: "First choice",
        preview: "preview body",
      },
    ],
  }) satisfies PendingWorkbenchAsk["questions"][number];

describe("AskQuestionField", () => {
  it.each(["single", "preview", "multi"] as const)(
    "offers an unconditional custom answer for %s questions",
    async (type) => {
      const target = renderQuestion(choiceQuestion(type));
      await tick();

      const customChoice = target.querySelector<HTMLInputElement>(
        `[value="${hubCustomAnswerValue}"]`,
      );
      const customAnswer = target.querySelector<HTMLTextAreaElement>(
        `[name="custom-answer:${type}-choice"]`,
      );
      expect(customChoice).not.toBeNull();
      expect(customAnswer).not.toBeNull();
      expect(target.querySelector(".option-preview")?.textContent).toContain("preview body");

      customAnswer?.focus();
      await tick();
      expect(customChoice?.checked).toBe(true);
      expect(customChoice?.type).toBe(type === "multi" ? "checkbox" : "radio");
      expect(customChoice?.required).toBe(type === "multi" ? false : true);
    },
  );

  it("renders a required freeform question without choice controls", async () => {
    const target = renderQuestion({
      id: "freeform",
      type: "freeform",
      prompt: "Explain",
      required: true,
    });
    await tick();

    const answer = target.querySelector<HTMLTextAreaElement>('[name="answer:freeform"]');
    expect(answer?.required).toBe(true);
    expect(answer?.getAttribute("aria-label")).toBe("Explain");
    expect(target.querySelector("[data-custom-answer-choice]")).toBeNull();
  });
});
