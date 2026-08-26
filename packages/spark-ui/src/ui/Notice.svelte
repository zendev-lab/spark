<script lang="ts">
  let {
    message,
    tone = "info",
    role = tone === "danger" ? "alert" : "status",
  }: {
    message: string;
    tone?: "info" | "success" | "warning" | "danger";
    role?: "alert" | "status";
  } = $props();
</script>

<p class="ui-notice" data-tone={tone} {role}>{message}</p>

<style>
  .ui-notice {
    background: var(--color-info-soft);
    border: 1px solid color-mix(in srgb, var(--color-info) 24%, var(--color-border));
    border-radius: var(--rounded-md);
    color: var(--color-info-strong);
    font-size: var(--text-caption);
    line-height: var(--leading-caption);
    margin: 0;
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .ui-notice[data-tone="success"] {
    background: var(--color-success-weak);
    border-color: color-mix(in srgb, var(--color-success) 24%, var(--color-border));
    color: var(--color-success-strong);
  }

  .ui-notice[data-tone="warning"] {
    background: var(--color-warning-weak);
    border-color: color-mix(in srgb, var(--color-warning) 24%, var(--color-border));
    color: var(--color-warning-strong);
  }

  .ui-notice[data-tone="danger"] {
    background: var(--color-danger-weak);
    border-color: color-mix(in srgb, var(--color-danger) 24%, var(--color-border));
    color: var(--color-danger-strong);
  }
</style>
