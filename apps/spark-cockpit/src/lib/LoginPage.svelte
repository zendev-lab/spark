<script lang="ts">
  import { Button, Field, Input, Panel } from "@zendev-lab/spark-ui";

  interface LoginCopy {
    action: string;
    eyebrow: string;
    headTitle: string;
    lede: string;
    title: string;
    tokenLabel: string;
    tokenPlaceholder: string;
    unconfigured: string;
  }

  let {
    available,
    copy,
    errorMessage,
    lede,
    next,
  }: {
    available: boolean;
    copy: LoginCopy;
    errorMessage?: string;
    lede: string;
    next: string;
  } = $props();
</script>

<svelte:head>
  <title>{copy.headTitle}</title>
</svelte:head>

<section class="login-shell">
  <Panel class="login-card" ariaLabelledby="login-title">
    <p class="eyebrow">{copy.eyebrow}</p>
    <h1 id="login-title">{copy.title}</h1>
    <p class="lede">{lede}</p>

    {#if !available}
      <div class="notice" role="alert">
        {copy.unconfigured}
      </div>
    {/if}

    {#if errorMessage}
      <div class="error" role="alert">{errorMessage}</div>
    {/if}

    <form method="POST">
      <input type="hidden" name="next" value={next} />
      <Field id="login-token" label={copy.tokenLabel} required>
        <Input
          id="login-token"
          name="token"
          type="password"
          autocomplete="current-password"
          placeholder={copy.tokenPlaceholder}
          required
        />
      </Field>
      <Button class="login-submit" type="submit" disabled={!available}>{copy.action}</Button>
    </form>
  </Panel>
</section>

<style>
  .login-shell {
    align-items: center;
    background:
      radial-gradient(circle at top left, rgba(37, 99, 235, 0.14), transparent 34rem),
      var(--color-canvas);
    color: var(--color-ink);
    display: grid;
    min-height: 100dvh;
    padding: clamp(18px, 5vw, 64px);
  }

  :global(.login-card) {
    margin: 0 auto;
    max-width: 520px;
    width: min(100%, 520px);
  }

  .eyebrow {
    color: var(--color-primary);
    font-size: var(--text-caption);
    font-weight: 850;
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  h1 {
    font-size: clamp(30px, 8vw, 44px);
    letter-spacing: -0.04em;
    line-height: 1;
    margin: 0;
  }

  .lede {
    color: var(--color-ink-subtle);
    line-height: var(--leading-body);
    margin: 0;
  }

  form {
    display: grid;
    gap: var(--spacing-sm);
  }

  :global(.login-submit) { width: 100%; }

  .notice,
  .error {
    border-radius: var(--rounded-lg);
    font-size: var(--text-body);
    line-height: var(--leading-body);
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .notice {
    background: var(--color-warning-soft);
    color: var(--color-warning);
  }

  .error {
    background: var(--color-danger-weak);
    color: var(--color-danger-strong);
  }
</style>
