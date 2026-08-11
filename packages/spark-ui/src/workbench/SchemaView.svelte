<script lang="ts">
  import CodeBlock from "./CodeBlock.svelte";
  import { formatWorkbenchValue } from "./view";
  import type { WorkbenchDisplayValue } from "./types";

  type Props = {
    title: string;
    schema: WorkbenchDisplayValue;
    copyLabel: string;
    onCopy?: (schema: string) => void | Promise<void>;
  };
  let { title, schema, copyLabel, onCopy }: Props = $props();
  let code = $derived(formatWorkbenchValue(schema));
</script>

<CodeBlock view={{ code, language: "json", filename: title }} {copyLabel} {onCopy} />
