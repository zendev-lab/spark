<script lang="ts">
  import { Confirmation } from "../workbench";
  import type { Snippet } from "svelte";
  import type { ConversationApprovalState, ConversationPartLabels } from "./types";

  type Props = {
    requestId: string;
    title: string;
    state: ConversationApprovalState;
    kind?: string;
    summary?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
    actions?: Snippet;
  };

  let { requestId, title, state, kind, summary, labels, statusLabel, actions }: Props = $props();
</script>

{#snippet actionContent()}{#if actions}{@render actions()}{/if}{/snippet}

<Confirmation
  view={{
    id: requestId,
    title,
    status: state,
    description: summary,
    detail: kind ?? labels.approval,
  }}
  {statusLabel}
  actions={actions ? actionContent : undefined}
/>
