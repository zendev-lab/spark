<script lang="ts">
  import Icon from "$lib/Icon.svelte";
  import { formatRelativeTime, statusLabel as getStatusLabel } from "$lib/i18n";
  import TokenManagementSurface from "$lib/TokenManagementSurface.svelte";
  import { Button, PageHeader } from "$lib/ui";

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
      message={form?.intent === "cockpitAccess" ? form?.message : null}
      tableTitle={t.access.tableTitle}
      tableCount={`${data.accessTokens.length} ${t.access.tableCount}`}
      emptyIcon="user"
      emptyTitle={t.access.emptyTitle}
      emptyBody={t.access.emptyBody}
      hasTokens={data.accessTokens.length > 0}
    >
      {#if form?.intent === "cockpitAccess" && form?.accessToken}
        {#snippet created()}
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
        {/snippet}
      {/if}
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
            <form method="POST" action="?/revokeAccessToken">
              <input type="hidden" name="tokenId" value={token.id} />
              <Button variant="secondary" size="compact" type="submit" disabled={status !== "ready"}>
                {t.access.revoke}
              </Button>
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
