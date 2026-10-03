<script lang="ts">
  import {
    hasRequiredSparkAskGateSelections,
    hasSparkAskAnswerContent,
    type SparkInteractionRequest,
    type SparkAskQuestionView,
  } from "@zendev-lab/spark-protocol";

  export interface HumanInteractionPanelLabels {
    region: string;
    customAnswer: string;
    customPlaceholder: string;
    selectPlaceholder: string;
    required: string;
    answer: string;
    answering: string;
    cancel: string;
  }

  let {
    title,
    prompt,
    questions,
    mode,
    labels,
    disabled = false,
    onRespond,
  }: {
    title: string;
    prompt: string;
    questions: SparkAskQuestionView[];
    mode?: Extract<SparkInteractionRequest, { kind: "askFlow" }>["mode"];
    labels: HumanInteractionPanelLabels;
    disabled?: boolean;
    onRespond: (response: {
      status: "answered" | "cancelled";
      answers: Record<string, unknown>;
    }) => void | Promise<void>;
  } = $props();

  let selections = $state<Record<string, string[]>>({});
  let customSelections = $state<Record<string, boolean>>({});
  let customAnswers = $state<Record<string, string>>({});
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  $effect(() => {
    const defaults = Object.fromEntries(
      questions.flatMap((question) => {
        if (question.type === "freeform" || selections[question.id] !== undefined) return [];
        const optionValues = new Set(question.options.map((option) => option.value));
        const values = (question.defaultValues ?? []).filter((value) => optionValues.has(value));
        const selected = question.type === "multi" ? values : values.slice(0, 1);
        return selected.length > 0 ? [[question.id, selected]] : [];
      }),
    );
    if (Object.keys(defaults).length > 0) selections = { ...selections, ...defaults };
  });

  function selection(questionId: string): string[] {
    return selections[questionId] ?? [];
  }

  function setSingle(questionId: string, value: string) {
    selections = { ...selections, [questionId]: value ? [value] : [] };
    customSelections = { ...customSelections, [questionId]: false };
  }

  function toggleMulti(questionId: string, value: string, checked: boolean) {
    const next = new Set(selection(questionId));
    if (checked) next.add(value);
    else next.delete(value);
    selections = { ...selections, [questionId]: [...next] };
  }

  function setCustom(question: SparkAskQuestionView, checked: boolean) {
    customSelections = { ...customSelections, [question.id]: checked };
    if (checked && question.type !== "multi") {
      selections = { ...selections, [question.id]: [] };
    }
  }

  function answerFor(question: SparkAskQuestionView) {
    const selected = selection(question.id);
    const acceptsText =
      question.type === "freeform" || question.options.length === 0 || customSelections[question.id];
    const customText = acceptsText ? customAnswers[question.id]?.trim() : undefined;
    const labelsForValues = selected.flatMap((value) => {
      const option = question.options.find((candidate) => candidate.value === value);
      return option ? [option.label] : [];
    });
    return {
      values: selected,
      ...(labelsForValues.length > 0 ? { labels: labelsForValues } : {}),
      ...(customText ? { customText } : {}),
    };
  }

  async function respond(status: "answered" | "cancelled") {
    if (submitting || disabled) return;
    const answers =
      status === "cancelled"
        ? {}
        : Object.fromEntries(questions.map((question) => [question.id, answerFor(question)]));
    if (
      status === "answered" &&
      (questions.some(
        (question) => question.required && !hasSparkAskAnswerContent(answers[question.id]),
      ) ||
        !hasRequiredSparkAskGateSelections(mode, questions, answers))
    ) {
      errorMessage = labels.required;
      return;
    }
    submitting = true;
    errorMessage = null;
    try {
      await onRespond({ status, answers });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      submitting = false;
    }
  }
</script>

<section class="human-interaction" aria-label={labels.region}>
  <header>
    <h2>{title}</h2>
    <p>{prompt}</p>
  </header>
  <div class="questions">
    {#each questions as question (question.id)}
      <fieldset disabled={disabled || submitting}>
        <legend>{question.prompt}{question.required ? " *" : ""}</legend>
        {#if question.type === "multi"}
          <div class="options">
            {#each question.options as option (option.value)}
              <label>
                <input
                  type="checkbox"
                  checked={selection(question.id).includes(option.value)}
                  onchange={(event) => toggleMulti(question.id, option.value, event.currentTarget.checked)}
                />
                <span><strong>{option.label}</strong>{#if option.description}<small>{option.description}</small>{/if}</span>
              </label>
            {/each}
            <label>
              <input
                type="checkbox"
                checked={customSelections[question.id] === true}
                onchange={(event) => setCustom(question, event.currentTarget.checked)}
              />
              <span>{labels.customAnswer}</span>
            </label>
          </div>
          {#if customSelections[question.id]}
            <textarea
              aria-label={`${question.prompt}: ${labels.customAnswer}`}
              bind:value={customAnswers[question.id]}
              rows="3"
              placeholder={labels.customPlaceholder}
            ></textarea>
          {/if}
        {:else if question.type === "freeform" || question.options.length === 0}
          <textarea
            aria-label={question.prompt}
            bind:value={customAnswers[question.id]}
            rows="4"
            placeholder={labels.customPlaceholder}
          ></textarea>
        {:else}
          <select
            aria-label={question.prompt}
            value={selection(question.id)[0] ?? ""}
            onchange={(event) => setSingle(question.id, event.currentTarget.value)}
          >
            <option value="">{labels.selectPlaceholder}</option>
            {#each question.options as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          {@const selectedOption = question.options.find((option) => option.value === selection(question.id)[0])}
          {#if selectedOption?.description}<p class="description">{selectedOption.description}</p>{/if}
          {#if selectedOption?.preview}<pre>{selectedOption.preview}</pre>{/if}
          <label class="custom-option">
            <input
              type="checkbox"
              checked={customSelections[question.id] === true}
              onchange={(event) => setCustom(question, event.currentTarget.checked)}
            />
            <span>{labels.customAnswer}</span>
          </label>
          {#if customSelections[question.id]}
            <textarea
              aria-label={`${question.prompt}: ${labels.customAnswer}`}
              bind:value={customAnswers[question.id]}
              rows="3"
              placeholder={labels.customPlaceholder}
            ></textarea>
          {/if}
        {/if}
      </fieldset>
    {/each}
  </div>
  {#if errorMessage}<p class="error" role="alert">{errorMessage}</p>{/if}
  <footer>
    <button type="button" class="secondary" disabled={disabled || submitting} onclick={() => void respond("cancelled")}>
      {labels.cancel}
    </button>
    <button type="button" disabled={disabled || submitting} onclick={() => void respond("answered")}>
      {submitting ? labels.answering : labels.answer}
    </button>
  </footer>
</section>

<style>
  .human-interaction {
    background: var(--color-warning-soft, var(--color-surface-soft));
    border: 1px solid var(--color-warning, var(--color-border));
    border-radius: var(--rounded-lg);
    display: grid;
    gap: 12px;
    padding: 12px;
  }
  header,
  .questions,
  fieldset,
  .options {
    display: grid;
    gap: 8px;
  }
  h2,
  p {
    margin: 0;
  }
  header p,
  .description {
    color: var(--color-ink-muted);
    font-size: var(--text-caption);
  }
  fieldset {
    border: 0;
    margin: 0;
    min-width: 0;
    padding: 0;
  }
  legend {
    font-weight: 650;
    margin-bottom: 6px;
  }
  .options label {
    align-items: start;
    display: grid;
    gap: 7px;
    grid-template-columns: auto minmax(0, 1fr);
  }
  .custom-option {
    align-items: center;
    display: flex;
    gap: 7px;
  }
  .options span {
    display: grid;
    gap: 2px;
  }
  .options small {
    color: var(--color-ink-muted);
  }
  select,
  textarea {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    box-sizing: border-box;
    color: var(--color-ink);
    padding: 8px;
    width: 100%;
  }
  pre {
    background: var(--color-canvas);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-sm);
    max-height: 180px;
    overflow: auto;
    padding: 8px;
    white-space: pre-wrap;
  }
  footer {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
  footer button {
    background: var(--color-primary);
    border: 1px solid var(--color-primary);
    border-radius: var(--rounded-md);
    color: var(--color-on-primary);
    cursor: pointer;
    padding: 7px 12px;
  }
  footer button.secondary {
    background: var(--color-surface);
    border-color: var(--color-border);
    color: var(--color-ink-muted);
  }
  .error {
    color: var(--color-danger);
  }
  button:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  input:focus-visible {
    box-shadow: var(--shadow-focus);
    outline: none;
  }
</style>
