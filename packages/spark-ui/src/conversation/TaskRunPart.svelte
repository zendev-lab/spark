<script lang="ts">
  import { Task } from "../workbench";
  import type { ConversationPartLabels, ConversationTaskState } from "./types";

  type Props = {
    taskRef: string;
    title: string;
    state: ConversationTaskState;
    summary?: string;
    labels: ConversationPartLabels;
    statusLabel: (status: string) => string;
  };

  let { taskRef, title, state, summary, labels, statusLabel }: Props = $props();
</script>

<Task
  view={{ id: taskRef, title, status: state, summary }}
  {statusLabel}
  taskLabel={labels.task}
/>
