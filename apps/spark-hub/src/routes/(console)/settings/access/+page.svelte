<script lang="ts">
  import { enhance } from "$app/forms";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import TokenManagementSurface from "$lib/TokenManagementSurface.svelte";
  import { ConfirmDialog, PageHeader } from "@zendev-lab/spark-ui";
  import { DialogTrigger } from "@zendev-lab/spark-ui/headless";

  let { data, form } = $props();

  let t = $derived(data.messages.settings);
  let common = $derived(data.messages.common);

  function formatRelative(value: string | null) {
    return formatRelativeTime(value, data.locale, common);
  }

  function statusLabel(status: string) {
    return getStatusLabel(status, common);
  }

  function accessStatus(token: {
    expiresAt: string | null;
    usedAt: string | null;
    revokedAt: string | null;
  }) {
    if (token.revokedAt) return "revoked";
    if (token.usedAt) return "used";
    if (token.expiresAt && token.expiresAt < new Date().toISOString()) return "expired";
    return "ready";
  }

  let revokingId = $state<string | null>(null);
</script>

<svelte:head>
  <title>{t.access.title} · {t.headTitle}</title>
</svelte:head>

<section class="access-page">
  <PageHeader title={t.access.title} lede={t.access.body} />

  <TokenManagementSurface
      formAction="?/createAccessToken"
      fieldId="access-label"
      fieldLabel={t.access.label}
      fieldPlaceholder={t.access.labelPlaceholder}
      submitLabel={t.access.createToken}
      heading={t.access.createHeading}
      body={t.access.createBody}
      icon="user"
      message={form?.intent === "hubAccess" ? form?.message : null}
      tableTitle={t.access.tableTitle}
      tableCount={`${data.accessTokens.length} ${t.access.tableCount}`}
      emptyIcon="user"
      emptyTitle={t.access.emptyTitle}
      emptyBody={t.access.emptyBody}
      hasTokens={data.accessTokens.length > 0}
    >
      {#snippet created()}
        {#if form?.intent === "hubAccess" && form?.accessToken}
          <div class="token-created">
            <div>
              <strong>{t.access.tokenCreatedTitle}</strong>
              <p>{form.message}</p>
            </div>
            <div class="token-display">
              <span>{t.access.loginUrl}</span>
              <pre>{form.loginUrl}</pre>
            </div>
            <div class="token-display">
              <span>{t.access.oneTimeToken}</span>
              <pre>{form.accessToken}</pre>
            </div>
            <small>{t.access.expiresPrefix} {formatRelative(form.accessExpiresAt ?? null)}</small>
          </div>
        {/if}
      {/snippet}
      {#snippet tokens()}
        {#each data.accessTokens as token}
          {@const status = accessStatus(token)}
          <div class="token-row">
            <div>
              <strong>{token.label ?? t.access.defaultTokenLabel}</strong>
            </div>
            <span class="status-pill {status}">{statusLabel(status)}</span>
            <time><small>{t.enrollment.created}</small>{formatRelative(token.createdAt)}</time>
            <time><small>{t.enrollment.expires}</small>{formatRelative(token.expiresAt)}</time>
            <form
              id={`revoke-form-${token.id}`}
              method="POST"
              action="?/revokeAccessToken"
              use:enhance={() => {
                revokingId = token.id;
                return async ({ update }) => {
                  revokingId = null;
                  await update();
                };
              }}
            >
              <input type="hidden" name="tokenId" value={token.id} />
              <ConfirmDialog
                danger
                title={t.access.revokeConfirmTitle}
                description={t.access.revokeConfirm}
                confirmLabel={t.access.revoke}
                cancelLabel={t.access.revokeCancel}
                loading={revokingId === token.id}
                onConfirm={() =>
                  (document.getElementById(`revoke-form-${token.id}`) as HTMLFormElement | null)
                    ?.requestSubmit()
                }
              >
                {#snippet trigger()}
                  <DialogTrigger
                    class="revoke-trigger-button"
                    disabled={status !== "ready" || revokingId !== null}
                  >
                    {t.access.revoke}
                  </DialogTrigger>
                {/snippet}
              </ConfirmDialog>
            </form>
          </div>
        {/each}
      {/snippet}
  </TokenManagementSurface>
</section>

<style>
  .access-page {
    display: grid;
    gap: var(--spacing-lg);
    max-width: 880px;
    min-width: 0;
    width: 100%;
  }

  :global(.revoke-trigger-button) {
    align-items: center;
    background: var(--color-surface);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--rounded-md);
    color: var(--color-ink-muted);
    cursor: pointer;
    display: inline-flex;
    font-family: var(--font-sans);
    font-size: var(--text-caption);
    font-weight: var(--weight-button);
    justify-content: center;
    min-height: var(--control-height-compact);
    padding: 5px 10px;
  }

  :global(.revoke-trigger-button:not(:disabled)):hover {
    border-color: var(--color-primary-soft);
    color: var(--color-primary);
  }

  :global(.revoke-trigger-button:disabled) {
    background: var(--color-border);
    border-color: var(--color-border);
    color: var(--color-ink-disabled);
    cursor: not-allowed;
  }

  .token-created,
  .token-row {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
  }

  .device-heading {
    align-items: start;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .token-created p,
  .token-created small,
  .token-row small {
    color: var(--color-ink-subtle);
    font-size: 13px;
    line-height: 1.5;
  }

  .token-created,
  .empty-state,
  .token-row {
    background: var(--color-surface-soft);
    border: 1px solid var(--color-border-soft);
    border-radius: var(--rounded-md);
  }

  .token-created {
    display: grid;
    gap: 12px;
    padding: 14px;
  }

  .token-display {
    display: grid;
    gap: 6px;
  }

  .token-display span {
    color: var(--color-ink-muted);
    font-size: 12px;
    font-weight: 650;
  }

  .token-display pre {
    margin: 0;
    overflow-x: auto;
    padding: 10px 12px;
    border-radius: var(--rounded-sm);
    background: var(--color-canvas);
    border: 1px solid var(--color-border);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
  }

  .token-row {
    align-items: center;
    display: grid;
    gap: 10px;
    grid-template-columns: minmax(0, 1.4fr) auto minmax(0, 1fr) minmax(0, 1fr) auto;
    padding: 12px 14px;
  }

  .status-pill {
    border-radius: 999px;
    font-size: 12px;
    font-weight: 650;
    padding: 3px 8px;
  }

  .status-pill.ready {
    background: color-mix(in srgb, var(--color-success) 16%, transparent);
    color: var(--color-success);
  }

  .status-pill.used,
  .status-pill.expired,
  .status-pill.revoked {
    background: var(--color-surface);
    color: var(--color-ink-muted);
  }

  .form-message {
    color: var(--color-danger);
    font-size: 13px;
  }

  @media (max-width: 820px) {
    .token-row {
      grid-template-columns: 1fr;
    }
  }
</style>
