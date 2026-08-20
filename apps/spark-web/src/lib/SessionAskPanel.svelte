<script lang="ts">
  import {
    encodeWebAskAnswers,
    hasEncodableWebAskAnswer,
    missingRequiredWebAskPrompts,
    webCustomAnswerValue,
    type PendingWebAsk,
  } from "./pending-ask";

  let {
    ask,
    submitting = false,
    onRespond,
  }: {
    ask: PendingWebAsk;
    submitting?: boolean;
    onRespond: (input: {
      status: "answered" | "cancelled";
      answers: Record<string, unknown>;
    }) => void;
  } = $props();

  let selectedByQuestionId = $state<Record<string, string | string[]>>({});
  let customByQuestionId = $state<Record<string, string>>({});
  let fallbackMessage = $state("");
  let errorMessage = $state<string | null>(null);

  function selectedValue(questionId: string): string {
    const selected = selectedByQuestionId[questionId];
    return Array.isArray(selected) ? (selected[0] ?? "") : (selected ?? "");
  }

  function isChecked(questionId: string, value: string): boolean {
    const selected = selectedByQuestionId[questionId];
    return Array.isArray(selected) ? selected.includes(value) : selected === value;
  }

  function setSingle(questionId: string, value: string) {
    selectedByQuestionId = { ...selectedByQuestionId, [questionId]: value };
  }

  function toggleMulti(questionId: string, value: string, checked: boolean) {
    const current = selectedByQuestionId[questionId];
    const values = new Set(Array.isArray(current) ? current : current ? [current] : []);
    if (checked) values.add(value);
    else values.delete(value);
    selectedByQuestionId = { ...selectedByQuestionId, [questionId]: [...values] };
  }

  function setCustom(questionId: string, value: string) {
    customByQuestionId = { ...customByQuestionId, [questionId]: value };
    const question = ask.questions.find((item) => item.id === questionId);
    if (!question) return;
    if (question.type === "multi") {
      if (!isChecked(questionId, webCustomAnswerValue)) {
        toggleMulti(questionId, webCustomAnswerValue, true);
      }
      return;
    }
    setSingle(questionId, webCustomAnswerValue);
  }

  function currentAnswers(): Record<string, unknown> {
    return encodeWebAskAnswers({
      questions: ask.questions,
      selectedByQuestionId,
      customByQuestionId,
      fallbackMessage,
    });
  }

  function submitAnswer(event: Event) {
    event.preventDefault();
    const answers = currentAnswers();
    const missing = missingRequiredWebAskPrompts(ask.questions, answers);
    if (missing.length > 0) {
      errorMessage = `Required: ${missing[0]}`;
      return;
    }
    if (!hasEncodableWebAskAnswer(answers)) {
      errorMessage = "Choose an option or add an answer before sending.";
      return;
    }
    errorMessage = null;
    onRespond({ status: "answered", answers });
  }

  function cancelAsk() {
    errorMessage = null;
    onRespond({ status: "cancelled", answers: {} });
  }
</script>

<article class="ask-card">
  <header>
    {#if ask.questions[0]?.header}
      <p class="kicker">{ask.questions[0].header}</p>
    {/if}
    <h2>{ask.title || "Waiting for you"}</h2>
    {#if ask.prompt}
      <p class="prompt">{ask.prompt}</p>
    {/if}
  </header>

  <form onsubmit={submitAnswer}>
    {#if ask.questions.length === 0}
      <label class="freeform">
        <span>Answer</span>
        <textarea bind:value={fallbackMessage} rows="3" disabled={submitting}></textarea>
      </label>
    {:else}
      {#each ask.questions as question (question.id)}
        <fieldset class="question">
          <legend>
            {question.prompt}{question.required ? " *" : ""}
          </legend>

          {#if (question.type === "single" || question.type === "preview") && question.options?.length}
            <div class="options">
              {#each question.options as option (option.value)}
                <label class="option" class:selected={selectedValue(question.id) === option.value}>
                  <input
                    type="radio"
                    name={`answer:${ask.interactionRequestId}:${question.id}`}
                    value={option.value}
                    checked={selectedValue(question.id) === option.value}
                    disabled={submitting}
                    onchange={() => setSingle(question.id, option.value)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {#if option.description}<small>{option.description}</small>{/if}
                    {#if option.preview}<code>{option.preview}</code>{/if}
                  </span>
                </label>
              {/each}
              <label
                class="option custom"
                class:selected={selectedValue(question.id) === webCustomAnswerValue}
              >
                <input
                  type="radio"
                  name={`answer:${ask.interactionRequestId}:${question.id}`}
                  value={webCustomAnswerValue}
                  checked={selectedValue(question.id) === webCustomAnswerValue}
                  disabled={submitting}
                  onchange={() => setSingle(question.id, webCustomAnswerValue)}
                />
                <span>
                  <strong>Type your own</strong>
                  <textarea
                    rows="3"
                    placeholder="Custom answer"
                    disabled={submitting}
                    value={customByQuestionId[question.id] ?? ""}
                    oninput={(event) =>
                      setCustom(question.id, (event.currentTarget as HTMLTextAreaElement).value)}
                  ></textarea>
                </span>
              </label>
            </div>
          {:else if question.type === "multi" && question.options?.length}
            <div class="options">
              {#each question.options as option (option.value)}
                <label class="option" class:selected={isChecked(question.id, option.value)}>
                  <input
                    type="checkbox"
                    value={option.value}
                    checked={isChecked(question.id, option.value)}
                    disabled={submitting}
                    onchange={(event) =>
                      toggleMulti(
                        question.id,
                        option.value,
                        (event.currentTarget as HTMLInputElement).checked,
                      )}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    {#if option.description}<small>{option.description}</small>{/if}
                    {#if option.preview}<code>{option.preview}</code>{/if}
                  </span>
                </label>
              {/each}
              <label
                class="option custom"
                class:selected={isChecked(question.id, webCustomAnswerValue)}
              >
                <input
                  type="checkbox"
                  value={webCustomAnswerValue}
                  checked={isChecked(question.id, webCustomAnswerValue)}
                  disabled={submitting}
                  onchange={(event) =>
                    toggleMulti(
                      question.id,
                      webCustomAnswerValue,
                      (event.currentTarget as HTMLInputElement).checked,
                    )}
                />
                <span>
                  <strong>Type your own</strong>
                  <textarea
                    rows="3"
                    placeholder="Custom answer"
                    disabled={submitting}
                    value={customByQuestionId[question.id] ?? ""}
                    oninput={(event) =>
                      setCustom(question.id, (event.currentTarget as HTMLTextAreaElement).value)}
                  ></textarea>
                </span>
              </label>
            </div>
          {:else}
            <textarea
              rows="4"
              placeholder="Answer"
              disabled={submitting}
              value={typeof selectedByQuestionId[question.id] === "string"
                ? selectedByQuestionId[question.id]
                : ""}
              oninput={(event) =>
                setSingle(question.id, (event.currentTarget as HTMLTextAreaElement).value)}
            ></textarea>
          {/if}
        </fieldset>
      {/each}
    {/if}

    {#if errorMessage}
      <p class="error" role="alert">{errorMessage}</p>
    {/if}

    <footer>
      <button type="button" onclick={cancelAsk} disabled={submitting}>Cancel</button>
      <button type="submit" disabled={submitting}>{submitting ? "Sending" : "Answer"}</button>
    </footer>
  </form>
</article>

<style>
  .ask-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 12px;
    display: grid;
    gap: 12px;
    padding: 14px;
  }
  header,
  .question,
  .options,
  footer {
    display: grid;
    gap: 8px;
  }
  h2 {
    font-size: 1rem;
    margin: 0;
  }
  .kicker,
  .prompt,
  small {
    color: var(--color-ink-muted);
    margin: 0;
  }
  fieldset {
    border: 0;
    margin: 0;
    min-width: 0;
    padding: 0;
  }
  legend,
  .freeform span,
  strong {
    font-weight: 650;
  }
  .option {
    align-items: start;
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 10px;
    cursor: pointer;
    display: grid;
    gap: 8px;
    grid-template-columns: auto minmax(0, 1fr);
    padding: 10px 12px;
  }
  .option.selected {
    border-color: var(--color-ink);
  }
  .option span {
    display: grid;
    gap: 4px;
    min-width: 0;
  }
  textarea,
  code {
    width: 100%;
    box-sizing: border-box;
  }
  textarea {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: inherit;
    font: inherit;
    min-height: 72px;
    padding: 8px;
  }
  code {
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    color: var(--color-ink-muted);
    font-size: 0.8rem;
    max-height: 160px;
    overflow: auto;
    padding: 8px;
    white-space: pre-wrap;
  }
  .error {
    color: var(--color-danger, #b42318);
    margin: 0;
  }
  footer {
    grid-template-columns: auto auto;
    justify-content: end;
  }
  button {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    color: inherit;
    cursor: pointer;
    padding: 8px 12px;
  }
  button[type="submit"] {
    background: var(--color-ink);
    color: var(--color-canvas);
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
</style>
