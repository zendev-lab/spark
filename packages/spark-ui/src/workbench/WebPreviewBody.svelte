<script lang="ts">
  import { safeWorkbenchHref } from "./view";
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    src?: string;
    documentHtml?: string;
    empty?: Snippet;
  };

  let { title, src: candidateSrc, documentHtml, empty }: Props = $props();
  let src = $derived(documentHtml === undefined ? safeWorkbenchHref(candidateSrc) : undefined);
  let hasDocument = $derived(documentHtml !== undefined);
</script>

{#if hasDocument || src}
  <iframe
    class="web-preview-frame"
    {title}
    {src}
    srcdoc={documentHtml}
    sandbox=""
    referrerpolicy="no-referrer"
  ></iframe>
{:else if empty}
  {@render empty()}
{/if}

<style>
  .web-preview-frame {
    background: white;
    border: 0;
    display: block;
    height: min(70vh, 760px);
    min-height: 32rem;
    width: 100%;
  }

  @media (max-width: 640px) {
    .web-preview-frame { min-height: 24rem; }
  }
</style>
