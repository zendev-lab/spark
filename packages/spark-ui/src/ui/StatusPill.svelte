<script lang="ts">
  let {
    label,
    status,
    tone,
  }: {
    label: string;
    status?: string;
    tone?: "neutral" | "info" | "success" | "warning" | "danger";
  } = $props();

  let semanticClass = $derived(status?.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-") ?? "");
</script>

<span class="status-pill {semanticClass}" data-tone={tone}>{label}</span>

<style>
  @import "./status-pill.css";

  .status-pill[data-tone="info"] {
    background: var(--color-primary-weak);
    color: var(--color-primary);
  }

  .status-pill[data-tone="success"] {
    background: var(--color-success-soft);
    color: var(--color-success-strong);
  }

  .status-pill[data-tone="warning"] {
    background: var(--color-warning-soft);
    color: var(--color-warning-strong);
  }

  .status-pill[data-tone="danger"] {
    background: var(--color-danger-soft);
    color: var(--color-danger-strong);
  }
</style>
