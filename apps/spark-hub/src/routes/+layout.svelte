<script lang="ts">
  import { onMount } from "svelte";
  import "@zendev-lab/spark-ui/tokens.css";

  let { children } = $props();

  // Keep the theme-color meta in sync with the design token so browser chrome
  // tracks palette changes instead of a hardcoded hex copy.
  onMount(() => {
    const primary = getComputedStyle(document.documentElement)
      .getPropertyValue("--color-primary")
      .trim();
    if (primary) {
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", primary);
    }
  });
</script>

<svelte:head>
  <meta name="theme-color" content="#2563EB" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Spark" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/icons/spark.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/icons/spark-maskable.svg" />
</svelte:head>

{@render children()}
