<script lang="ts">
  import {
    hasSparkAskAnswerContent,
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

  const customValue = "__spark_custom_answer__";

  let {
    title,
    prompt,
    questions,
    labels,
    disabled = false,
    onRespond,
  }: {
    title: string;
    prompt: string;
    questions: SparkAskQuestionView[];
    labels: HumanInteractionPanelLabels;
    disabled?: boolean;
    onRespond: (response: {
      status: "answered" | "cancelled";
      answers: Record<string, unknown>;
    }) => void | Promise<void>;
  } = $props();

  let selections = $state<Record<string, string[]>>({});
  let customAnswers = $state<Record<string, string>>({});
  let submitting = $state(false);
  let errorMessage = $state<string | null>(null);

  function selection(questionId: string): string[] {
    return selections[questionId] ?? [];
  }

  function setSingle(questionId: string, value: string) {
    selections = { ...selections, [questionId]: value ? [value] : [] };
  }

  function toggleMulti(questionId: string, value: string, checked: boolean) {
    const next = new Set(selection(questionId));
    if (checked) next.add(value);
    else next.delete(value);
    selections = { ...selections, [questionId]: [...next] };
  }

  function answerFor(question: SparkAskQuestionView) {
    const selected = selection(question.id);
    const customText = customAnswers[question.id]?.trim();
    const values = selected.filter((value) => value !== customValue);
    const labelsForValues = values.flatMap((value) => {
      const option = question.options.find((candidate) => candidate.value === value);
      return option ? [option.label] : [];
    });
    return {
      values,
      ...(labelsForValues.length > 0 ? { labels: labelsForValues } : {}),
      ...(customText ? { customText } : {}),
    };
  }

  async function respond(status: "answered" | "cancelled") {
    if (submitting || disabled) return;
    const answers = Object.fromEntries(questions.map((question) => [question.id, answerFor(question)]));
    if (
      status === "answered" &&
      questions.some((question) => question.required && !hasSparkAskAnswerContent(answers[question.id]))
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
                checked={selection(question.id).includes(customValue)}
                onchange={(event) => toggleMulti(question.id, customValue, event.currentTarget.checked)}
              />
              <span>{labels.customAnswer}</span>
            </label>
          </div>
          {#if selection(question.id).includes(customValue)}
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
            <option value={customValue}>{labels.customAnswer}</option>
          </select>
          {@const selectedOption = question.options.find((option) => option.value === selection(question.id)[0])}
          {#if selectedOption?.description}<p class="description">{selectedOption.description}</p>{/if}
          {#if selectedOption?.preview}<pre>{selectedOption.preview}</pre>{/if}
          {#if selection(question.id)[0] === customValue}
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
