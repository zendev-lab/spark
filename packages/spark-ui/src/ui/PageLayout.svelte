<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    width = "wide",
    compact = false,
    class: className = "",
    children,
  }: {
    width?: "compact" | "content" | "wide" | "full";
    compact?: boolean;
    class?: string;
    children: Snippet;
  } = $props();
</script>

<section class="ui-page-layout {className}" class:compact data-width={width}>
  {@render children()}
</section>

<style>
  .ui-page-layout {
    display: grid;
    gap: var(--spacing-xl);
    margin-inline: auto;
    max-width: var(--layout-wide-max);
    padding: var(--layout-page-padding-block) var(--layout-page-padding-inline) var(--spacing-section);
    width: 100%;
  }

  .ui-page-layout.compact {
    gap: var(--spacing-lg);
  }

  .ui-page-layout[data-width="compact"] {
    max-width: var(--layout-compact-max);
  }

  .ui-page-layout[data-width="content"] {
    max-width: var(--layout-content-max);
  }

  .ui-page-layout[data-width="full"] {
    max-width: none;
  }

  @media (max-width: 640px) {
    .ui-page-layout {
      gap: var(--spacing-lg);
      padding: var(--spacing-lg) var(--spacing-sm) var(--spacing-xxl);
    }
  }
</style>
