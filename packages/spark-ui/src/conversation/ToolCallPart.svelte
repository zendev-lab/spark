<script lang="ts">
  import { Tool } from "../workbench";
  import type { ConversationPartLabels, ConversationToolState } from "./types";

  type Props = {
    callId: string;
    name: string;
    state: ConversationToolState;
    summary?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
    nested?: boolean;
  };

  let { callId, name, state, summary, labels, statusLabel, nested = false }: Props = $props();
</script>

<Tool
  view={{ id: callId, name, status: state, summary }}
  {statusLabel}
  inputLabel={labels.tool}
  outputLabel={labels.tool}
  errorLabel={labels.tool}
  emptyLabel={`${labels.tool} · ${statusLabel(state)}`}
  {nested}
/>
