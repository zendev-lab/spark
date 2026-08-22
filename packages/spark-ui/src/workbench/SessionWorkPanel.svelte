<script lang="ts">
  import type { SparkSessionView } from "@zendev-lab/spark-protocol";

  import Artifact from "./Artifact.svelte";
  import Task from "./Task.svelte";
  import Tool from "./Tool.svelte";
  import WorkbenchPanel from "./WorkbenchPanel.svelte";
  import type { WorkbenchStatus } from "./types";

  export interface SessionWorkPanelLabels {
    region: string;
    work: string;
    activity: string;
    details: string;
    emptyWork: string;
    emptyActivity: string;
    emptyDetails: string;
    goal: string;
    repro: string;
    loop: string;
    workflow: string;
    task: string;
    toolInput: string;
    toolOutput: string;
    toolError: string;
    toolEmpty: string;
    artifactPreview: string;
    openArtifact: string;
  }

  let {
    snapshot,
    labels,
    onOpenArtifact,
  }: {
    snapshot: SparkSessionView;
    labels: SessionWorkPanelLabels;
    onOpenArtifact?: (artifactRef: string) => void | Promise<void>;
  } = $props();

  let tab = $state<"work" | "activity" | "details">("work");
  const statusLabel = (status: string) => status.replaceAll("_", " ");

  function workbenchStatus(status: string): WorkbenchStatus {
    switch (status) {
      case "running":
      case "pending":
      case "blocked":
      case "completed":
      case "failed":
      case "cancelled":
      case "approved":
      case "rejected":
      case "denied":
        return status;
      case "active":
      case "provisioning":
      case "scheduled":
      case "retry_wait":
      case "in_progress":
        return "running";
      case "waiting_attention":
      case "waiting_decision":
        return "awaiting-approval";
      case "complete":
      case "succeeded":
      case "done":
        return "completed";
      case "stopped":
      case "paused":
      case "dormant":
        return "cancelled";
      default:
        return "pending";
    }
  }
</script>

{#snippet artifactActions(view: { id: string })}
  {#if onOpenArtifact}
    <button type="button" onclick={() => void onOpenArtifact?.(view.id)}>{labels.openArtifact}</button>
  {/if}
{/snippet}

<section class="session-work-panel" aria-label={labels.region}>
  <div class="tabs" role="tablist" aria-label={labels.region}>
    <button type="button" role="tab" aria-selected={tab === "work"} onclick={() => (tab = "work")}>{labels.work}</button>
    <button type="button" role="tab" aria-selected={tab === "activity"} onclick={() => (tab = "activity")}>{labels.activity}</button>
    <button type="button" role="tab" aria-selected={tab === "details"} onclick={() => (tab = "details")}>{labels.details}</button>
  </div>

  <div class="panel" role="tabpanel">
    {#if tab === "work"}
      {#if snapshot.work?.goal}
        <WorkbenchPanel
          id={snapshot.work.goal.goalId}
          title={`${labels.goal}: ${snapshot.work.goal.objective}`}
          status={workbenchStatus(snapshot.work.goal.status)}
          statusLabel={statusLabel(snapshot.work.goal.status)}
          summary={snapshot.work.goal.reason}
        />
      {/if}
      {#if snapshot.work?.repro}
        <WorkbenchPanel
          id={snapshot.work.repro.reproId}
          title={`${labels.repro}: ${snapshot.work.repro.objective}`}
          status={workbenchStatus(snapshot.work.repro.status)}
          statusLabel={statusLabel(snapshot.work.repro.status)}
          summary={`${snapshot.work.repro.progress.accepted}/${snapshot.work.repro.progress.total}${snapshot.work.repro.blockingReason ? ` · ${snapshot.work.repro.blockingReason}` : ""}`}
        />
      {/if}
      {#each snapshot.loops ?? [] as loop (loop.loopId)}
        <WorkbenchPanel
          id={loop.loopId}
          title={`${labels.loop}: ${loop.loopId}`}
          status={workbenchStatus(loop.status)}
          statusLabel={statusLabel(loop.status)}
          summary={loop.reason ?? loop.error}
        />
      {/each}
      {#each snapshot.tasks as task (task.ref)}
        <Task
          view={{
            id: task.ref,
            title: task.title,
            status: workbenchStatus(task.status),
            description: task.description,
            summary: task.todos.length > 0 ? `${task.todos.filter((todo) => todo.status === "done").length}/${task.todos.length} todos` : undefined,
          }}
          {statusLabel}
          taskLabel={labels.task}
        />
      {/each}
      {#if !snapshot.work?.goal && !snapshot.work?.repro && (snapshot.loops?.length ?? 0) === 0 && snapshot.tasks.length === 0}
        <p class="empty">{labels.emptyWork}</p>
      {/if}
    {:else if tab === "activity"}
      {#each snapshot.runs as run (run.id)}
        <Task
          view={{
            id: run.id,
            title: run.title ?? `${labels.workflow}: ${run.kind}`,
            status: workbenchStatus(run.status),
            summary: run.summary,
          }}
          {statusLabel}
          taskLabel={labels.workflow}
        />
      {/each}
      {#each snapshot.tools as tool (tool.id)}
        <Tool
          view={{
            id: tool.id,
            name: tool.name,
            status: workbenchStatus(tool.status),
            input: tool.input,
            output: tool.output,
            error: tool.error ? { title: labels.toolError, message: tool.error } : undefined,
          }}
          {statusLabel}
          inputLabel={labels.toolInput}
          outputLabel={labels.toolOutput}
          errorLabel={labels.toolError}
          emptyLabel={labels.toolEmpty}
        />
      {/each}
      {#if snapshot.runs.length === 0 && snapshot.tools.length === 0}
        <p class="empty">{labels.emptyActivity}</p>
      {/if}
    {:else}
      {#each snapshot.artifacts as artifact (artifact.ref)}
        <Artifact
          view={{
            id: artifact.ref,
            title: artifact.title,
            kind: artifact.kind,
            status: artifact.status,
            summary: artifact.preview,
          }}
          previewLabel={labels.artifactPreview}
          {statusLabel}
          actions={onOpenArtifact ? artifactActions : undefined}
        />
      {/each}
      {#if snapshot.artifacts.length === 0}
        <p class="empty">{labels.emptyDetails}</p>
      {/if}
    {/if}
  </div>
</section>

<style>
  .session-work-panel { background: var(--color-surface); border-left: 1px solid var(--color-border); display: grid; grid-template-rows: auto minmax(0, 1fr); min-height: 0; min-width: 0; }
  .tabs { border-bottom: 1px solid var(--color-border); display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tabs button { background: transparent; border: 0; border-bottom: 2px solid transparent; color: var(--color-ink-muted); cursor: pointer; font: inherit; font-size: 11px; padding: 10px 4px 8px; }
  .tabs button[aria-selected="true"] { border-bottom-color: var(--color-primary); color: var(--color-ink); font-weight: 700; }
  .tabs button:focus-visible, :global(.session-work-panel .actions button:focus-visible) { box-shadow: var(--shadow-focus); outline: none; }
  .panel { display: grid; gap: 8px; min-height: 0; overflow: auto; padding: 10px; align-content: start; }
  .empty { color: var(--color-ink-muted); font-size: var(--text-caption); margin: 0; padding: 8px; }
  :global(.session-work-panel .actions button) { background: transparent; border: 1px solid var(--color-border); border-radius: var(--rounded-sm); color: var(--color-primary); cursor: pointer; font: inherit; font-size: 11px; padding: 4px 7px; }
</style>
