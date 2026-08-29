<script lang="ts">
  import { enhance } from "$app/forms";
  import type { Snippet } from "svelte";
  import { Icon } from "@zendev-lab/spark-ui";
  import type { IconName } from "@zendev-lab/spark-ui";
  import { Button, Field, Input } from "@zendev-lab/spark-ui";

  let {
    heading,
    body,
    icon,
    formAction,
    fieldId,
    fieldLabel,
    fieldPlaceholder,
    submitLabel,
    message,
    messageRole = "alert",
    tableTitle,
    tableCount,
    emptyIcon,
    emptyTitle,
    emptyBody,
    hasTokens,
    submitDisabled = false,
    fields,
    created,
    tokens,
  }: {
    heading?: string;
    body?: string;
    icon?: IconName;
    formAction: string;
    fieldId: string;
    fieldLabel: string;
    fieldPlaceholder: string;
    submitLabel: string;
    message?: string | null;
    messageRole?: "alert" | "status";
    tableTitle: string;
    tableCount: string;
    emptyIcon: IconName;
    emptyTitle: string;
    emptyBody: string;
    hasTokens: boolean;
    submitDisabled?: boolean;
    fields?: Snippet;
    created?: Snippet;
    tokens: Snippet;
    children?: Snippet;
  } = $props();

  let submitting = $state(false);
</script>

<section class="panel-card">
  {#if heading}
    <div class="device-heading">
      <div>
        <h2>{heading}</h2>
        {#if body}<p>{body}</p>{/if}
      </div>
      {#if icon}<Icon name={icon} size={20} />{/if}
    </div>
  {/if}

  <form
    class="token-form"
    method="POST"
    action={formAction}
    use:enhance={() => {
      submitting = true;
      return async ({ update }) => {
        submitting = false;
        await update();
      };
    }}
  >
    <div class="token-fields">
      <Field id={fieldId} label={fieldLabel} reserveMeta={false}>
        <Input id={fieldId} name="label" placeholder={fieldPlaceholder} />
      </Field>
      {#if fields}
        {@render fields()}
      {/if}
    </div>
    <Button type="submit" loading={submitting} disabled={submitDisabled}>
      <Icon name="plus" size={16} stroke={2.4} />
      <span>{submitLabel}</span>
    </Button>
  </form>

  {#if created}
    {@render created()}
  {:else if message}
    <p class="form-message" role={messageRole}>{message}</p>
  {/if}

  <article class="token-table">
    <div class="table-heading">
      <h3>{tableTitle}</h3>
      <span>{tableCount}</span>
    </div>
    {#if hasTokens}
      <div class="token-list">{@render tokens()}</div>
    {:else}
      <div class="empty-state">
        <Icon name={emptyIcon} size={20} />
        <div>
          <strong>{emptyTitle}</strong>
          <p>{emptyBody}</p>
        </div>
      </div>
    {/if}
  </article>
</section>

<style>
  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    color: var(--color-ink);
    font-size: 18px;
    line-height: 1.3;
  }

  h3 {
    color: var(--color-ink);
    font-size: 15px;
    line-height: 1.35;
  }

  .panel-card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-lg);
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  .device-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .device-heading p,
  .empty-state p {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .device-heading :global(svg) {
    color: var(--color-primary);
    flex: 0 0 auto;
  }

  .token-form {
    align-items: end;
    display: grid;
    gap: 12px;
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .token-fields {
    display: grid;
    gap: 12px;
    min-width: 0;
  }

  .token-table {
    border: 1px solid var(--color-border);
    border-radius: var(--rounded-md);
    display: grid;
    overflow: hidden;
  }

  .table-heading {
    align-items: center;
    background: var(--color-canvas);
    border-bottom: 1px solid var(--color-border);
    display: flex;
    gap: 12px;
    justify-content: space-between;
    min-height: 38px;
    padding: 0 12px;
  }

  .table-heading span {
    background: var(--color-primary-weak);
    border-radius: var(--rounded-full);
    color: var(--color-primary);
    font-size: 11px;
    font-weight: 800;
    padding: 4px 8px;
    white-space: nowrap;
  }

  .token-list {
    display: grid;
  }

  .empty-state {
    align-items: start;
    background: var(--color-surface-soft);
    border-radius: var(--rounded-md);
    display: flex;
    gap: 12px;
    padding: 14px;
  }

  .form-message {
    background: var(--color-warning-weak);
    border: 1px solid var(--color-warning-soft);
    border-radius: var(--rounded-md);
    color: var(--color-warning-strong);
    font-size: 13px;
    padding: 12px;
  }

  @media (max-width: 820px) {
    .token-form {
      grid-template-columns: 1fr;
    }
  }
</style>
