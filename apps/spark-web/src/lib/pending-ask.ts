import {
  hasSparkAskAnswerContent,
  parseSparkAskChoice,
  type SparkAskOptionLike,
} from "@zendev-lab/spark-protocol";

/** Radio/checkbox sentinel for the local workbench custom-answer control. */
export const webCustomAnswerValue = "__spark_web_custom_answer__";

export type WebAskQuestionType = "single" | "multi" | "preview" | "freeform";

export interface WebAskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface WebAskQuestion {
  id: string;
  prompt: string;
  type: WebAskQuestionType;
  required?: boolean;
  header?: string;
  options?: WebAskOption[];
}

export interface WebAskAnswer {
  values: string[];
  labels?: string[];
  customText?: string;
}

export interface PendingWebAsk {
  humanRequestId: string;
  interactionRequestId: string;
  sessionId: string;
  title: string;
  prompt: string;
  questions: WebAskQuestion[];
}

export function parseWebAskQuestions(value: unknown): WebAskQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((question) => {
    const normalized = normalizeWebAskQuestion(question);
    return normalized ? [normalized] : [];
  });
}

export function webSingleAnswerWithCustomFallback(
  question: WebAskQuestion,
  selected: string,
  customAnswer: string,
): WebAskAnswer {
  const value = selected.trim();
  if (value === webCustomAnswerValue || question.type === "freeform" || !question.options?.length) {
    const customText = (value === webCustomAnswerValue ? customAnswer : selected).trim();
    return {
      values: [],
      ...(customText ? { customText } : {}),
    };
  }

  if (!value) return { values: [] };
  return answerFromParsedChoice(question, value);
}

export function webMultiAnswerWithCustomFallback(
  question: WebAskQuestion,
  selected: readonly string[],
  customAnswer: string,
): WebAskAnswer {
  if (!question.options?.length) {
    const customText = selected
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n");
    return {
      values: [],
      ...(customText ? { customText } : {}),
    };
  }

  const values = [
    ...new Set(
      selected
        .map((value) => value.trim())
        .filter((value) => value && value !== webCustomAnswerValue),
    ),
  ];
  const answer = answerFromParsedChoice(question, values.join(","));
  const customText = selected.includes(webCustomAnswerValue) ? customAnswer.trim() : "";
  return {
    ...answer,
    ...(customText ? { customText } : {}),
  };
}

export function webAskAnswerHasValue(answer: WebAskAnswer): boolean {
  return hasSparkAskAnswerContent(answer);
}

export function encodeWebAskAnswers(input: {
  questions: readonly WebAskQuestion[];
  selectedByQuestionId: Record<string, string | readonly string[]>;
  customByQuestionId?: Record<string, string>;
  fallbackMessage?: string;
}): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  if (input.questions.length === 0) {
    const message = input.fallbackMessage?.trim() ?? "";
    if (message) answers.message = message;
    return answers;
  }

  for (const question of input.questions) {
    const customAnswer = input.customByQuestionId?.[question.id] ?? "";
    if (question.type === "multi") {
      const selected = input.selectedByQuestionId[question.id];
      const values = Array.isArray(selected) ? selected : selected ? [selected] : [];
      answers[question.id] = webMultiAnswerWithCustomFallback(question, values, customAnswer);
      continue;
    }
    const selected = input.selectedByQuestionId[question.id];
    const value = Array.isArray(selected) ? (selected[0] ?? "") : (selected ?? "");
    answers[question.id] = webSingleAnswerWithCustomFallback(question, value, customAnswer);
  }
  return answers;
}

export function missingRequiredWebAskPrompts(
  questions: readonly WebAskQuestion[],
  answers: Record<string, unknown>,
): string[] {
  return questions.flatMap((question) => {
    if (!question.required) return [];
    const answer = answers[question.id];
    if (!isWebAskAnswer(answer) || !webAskAnswerHasValue(answer)) return [question.prompt];
    return [];
  });
}

export function hasEncodableWebAskAnswer(answers: Record<string, unknown>): boolean {
  if (typeof answers.message === "string" && answers.message.trim()) return true;
  return Object.values(answers).some(
    (value) => isWebAskAnswer(value) && webAskAnswerHasValue(value),
  );
}

function isWebAskAnswer(value: unknown): value is WebAskAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as WebAskAnswer;
  return Array.isArray(candidate.values);
}

function answerFromParsedChoice(question: WebAskQuestion, choice: string): WebAskAnswer {
  const parsed = parseSparkAskChoice(toSparkAskOptions(question), choice, question.type);
  return {
    values: parsed.values,
    ...(parsed.labels.length > 0 ? { labels: parsed.labels } : {}),
    ...(parsed.customText ? { customText: parsed.customText } : {}),
  };
}

function toSparkAskOptions(question: WebAskQuestion): SparkAskOptionLike[] {
  return (question.options ?? []).map((option) => ({
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.preview ? { preview: option.preview } : {}),
  }));
}

function normalizeWebAskQuestion(value: unknown): WebAskQuestion | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const prompt =
    typeof candidate.prompt === "string"
      ? candidate.prompt
      : typeof candidate.question === "string"
        ? candidate.question
        : null;
  if (typeof candidate.id !== "string" || !prompt) return null;

  const type = normalizeQuestionType(candidate);
  const question: WebAskQuestion = {
    id: candidate.id,
    type,
    prompt,
  };
  if (typeof candidate.required === "boolean") question.required = candidate.required;
  if (typeof candidate.header === "string") question.header = candidate.header;
  if (Array.isArray(candidate.options)) {
    question.options = candidate.options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const candidateOption = option as Record<string, unknown>;
      const optionValue =
        typeof candidateOption.value === "string"
          ? candidateOption.value
          : typeof candidateOption.id === "string"
            ? candidateOption.id
            : null;
      if (!optionValue || typeof candidateOption.label !== "string") return [];
      return [
        {
          value: optionValue,
          label: candidateOption.label,
          ...(typeof candidateOption.description === "string"
            ? { description: candidateOption.description }
            : {}),
          ...(typeof candidateOption.preview === "string"
            ? { preview: candidateOption.preview }
            : {}),
        },
      ];
    });
  }
  return question;
}

function normalizeQuestionType(candidate: Record<string, unknown>): WebAskQuestionType {
  if (
    candidate.type === "single" ||
    candidate.type === "multi" ||
    candidate.type === "freeform" ||
    candidate.type === "preview"
  ) {
    return candidate.type;
  }
  if (candidate.multiSelect === true || candidate.multi_select === true) return "multi";
  if (Array.isArray(candidate.options) && candidate.options.length > 0) return "single";
  return "freeform";
}
