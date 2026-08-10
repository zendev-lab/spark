<script lang="ts">
  import Icon from "./Icon.svelte";
  import { defaultGitChangePreviewLabels } from "./git-change-preview";
  import type { GitChangePreviewLabels, GitChangePreviewModel } from "./git-change-preview";
  import SafeMarkdown from "./markdown/SafeMarkdown.svelte";

  let {
    change,
    labels = defaultGitChangePreviewLabels,
  }: { change: GitChangePreviewModel; labels?: GitChangePreviewLabels } = $props();

  function statusTone(value: string | undefined) {
    const normalized = value?.toLowerCase() ?? "";
    if (normalized.includes("fail") || normalized.includes("error") || normalized.includes("closed"))
      return "danger";
    if (normalized.includes("success") || normalized.includes("pass") || normalized.includes("merge"))
      return "success";
    if (normalized.includes("pending") || normalized.includes("queue") || normalized.includes("draft"))
      return "warning";
    return "neutral";
  }

  function safeExternalHref(value: string): string | undefined {
    try {
      const parsed = new URL(value);
      if (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        !parsed.username &&
        !parsed.password
      ) {
        return parsed.href;
      }
    } catch {
      // An invalid URL stays visible as Artifact metadata, but never becomes navigation.
    }
    return undefined;
  }
</script>

<section class="git-change-preview" aria-label={`${labels.stack}: ${change.repository.repo}`}>
  <header class="summary">
    <div class="identity">
      <span class="repo-icon"><Icon name="repos" size={18} /></span>
      <div>
        <span class="eyebrow">{labels.repository}</span>
        <strong>{change.repository.repo}</strong>
      </div>
    </div>
    <div class="summary-facts">
      <span><small>{labels.trunk}</small><code>{change.trunk}</code></span>
      <span><small>{labels.lifecycle}</small><b class="status {statusTone(change.lifecycle)}">{change.lifecycle}</b></span>
      <span><small>{labels.stack}</small><b>{change.stack.number ? `#${change.stack.number}` : change.stack.authority}</b></span>
    </div>
  </header>

  <ol class="stack-list">
    {#each change.stack.entries as entry, index (`${entry.branch}:${entry.base}:${index}`)}
      <li class:current={entry.isCurrent}>
        <div class="branch-line">
          <span class="node" aria-hidden="true"></span>
          <div class="branch-copy">
            <span class="eyebrow">{labels.branch} {index + 1}</span>
            <strong><code>{entry.branch}</code> <span aria-hidden="true">→</span> <code>{entry.base}</code></strong>
          </div>
          <div class="badges">
            {#if entry.isCurrent}<span class="badge current-badge">{labels.current}</span>{/if}
            {#if entry.isMerged}<span class="badge success">{labels.merged}</span>{/if}
            {#if entry.isQueued}<span class="badge warning">{labels.queued}</span>{/if}
            {#if entry.needsRebase}<span class="badge danger">{labels.needsRebase}</span>{/if}
          </div>
        </div>

        {#if entry.pullRequest}
          {@const pullRequest = entry.pullRequest}
          {@const pullRequestHref = safeExternalHref(pullRequest.url)}
          <article class="pull-request">
            <div class="pr-heading">
              <div>
                <div class="pr-meta">
                  <span class="badge {statusTone(pullRequest.state)}">{pullRequest.state}</span>
                  {#if pullRequest.draft}<span class="badge warning">{labels.draft}</span>{/if}
                  <span>#{pullRequest.number}</span>
                </div>
                <h2>{pullRequest.title}</h2>
                <p><code>{pullRequest.headRef}</code> <span aria-hidden="true">→</span> <code>{pullRequest.baseRef}</code></p>
              </div>
              {#if pullRequestHref}
                <a class="pr-link" href={pullRequestHref} target="_blank" rel="noopener noreferrer">
                  {labels.openPullRequest}<span aria-hidden="true">↗</span>
                </a>
              {/if}
            </div>

            {#if pullRequest.labels?.length || pullRequest.checksSummary}
              <div class="pr-facts">
                {#each pullRequest.labels ?? [] as label}<span class="label">{label}</span>{/each}
                {#if pullRequest.checksSummary}
                  <span class="checks"><small>{labels.checks}</small><b class="status {statusTone(pullRequest.checksSummary)}">{pullRequest.checksSummary}</b></span>
                {/if}
              </div>
            {/if}

            {#if pullRequest.bodyText}
              <section class="markdown" aria-label={labels.description}>
                <SafeMarkdown source={pullRequest.bodyText} streaming={false} />
              </section>
            {/if}

            {#if pullRequest.diffSummary}
              <details class="diff-details">
                <summary>{labels.diff}</summary>
                <pre><code>{pullRequest.diffSummary}</code></pre>
              </details>
            {/if}
          </article>
        {/if}
      </li>
    {/each}
  </ol>

  <details class="technical-details">
    <summary>{labels.technicalDetails}</summary>
    <dl>
      <div><dt>{labels.worktree}</dt><dd><code>{change.worktree.path ?? change.worktree.status}</code></dd></div>
      <div><dt>{labels.branch}</dt><dd><code>{change.worktree.branch ?? change.stack.currentBranch ?? "—"}</code></dd></div>
      <div><dt>{labels.ownership}</dt><dd>{change.worktree.ownership}</dd></div>
    </dl>
    {#if change.worktree.error}<p class="worktree-error">{change.worktree.error}</p>{/if}
    {#if change.cleanupBlockers?.length}
      <section>
        <strong>{labels.cleanupBlockers}</strong>
        <ul>{#each change.cleanupBlockers as blocker}<li>{blocker}</li>{/each}</ul>
      </section>
    {/if}
  </details>
</section>

<style>
  .git-change-preview { display: grid; gap: var(--spacing-lg); padding: var(--spacing-xl); }
  .summary { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-lg); padding-bottom: var(--spacing-lg); border-bottom: 1px solid var(--color-border); }
  .identity, .summary-facts, .branch-line, .pr-heading, .pr-meta, .pr-facts, .badges, .checks { display: flex; align-items: center; }
  .identity { gap: var(--spacing-sm); min-width: 0; }
  .identity strong { display: block; overflow-wrap: anywhere; }
  .repo-icon { display: grid; place-items: center; width: 2.25rem; height: 2.25rem; color: var(--color-primary); background: var(--color-primary-weak); border-radius: var(--rounded-lg); }
  .eyebrow, small { color: var(--color-ink-subtle); font-size: var(--text-caption); font-weight: var(--weight-card-title); letter-spacing: .04em; text-transform: uppercase; }
  .summary-facts { flex-wrap: wrap; justify-content: flex-end; gap: var(--spacing-md); }
  .summary-facts > span { display: grid; gap: .15rem; }
  .stack-list { display: grid; gap: var(--spacing-md); margin: 0; padding: 0; list-style: none; }
  .stack-list > li { position: relative; padding-inline-start: 1.5rem; }
  .stack-list > li::before { position: absolute; top: 1.1rem; bottom: calc(-1 * var(--spacing-md)); inset-inline-start: .35rem; width: 1px; background: var(--color-border-strong); content: ""; }
  .stack-list > li:last-child::before { display: none; }
  .node { position: absolute; inset-inline-start: -.05rem; width: .8rem; height: .8rem; background: var(--color-surface); border: 2px solid var(--color-border-strong); border-radius: 50%; }
  li.current .node { background: var(--color-primary); border-color: var(--color-primary); box-shadow: 0 0 0 4px var(--color-primary-soft); }
  .branch-line { position: relative; justify-content: space-between; gap: var(--spacing-md); min-height: 2.25rem; }
  .branch-copy { display: grid; gap: .15rem; min-width: 0; }
  .branch-copy strong { overflow-wrap: anywhere; }
  code { font-family: var(--font-mono); }
  .badges, .pr-meta, .pr-facts { flex-wrap: wrap; gap: var(--spacing-xs); }
  .badge, .status, .label { display: inline-flex; align-items: center; min-height: 1.45rem; padding: 0 .5rem; color: var(--color-ink-muted); background: var(--color-surface-soft); border: 1px solid var(--color-border); border-radius: 999px; font-size: var(--text-caption); font-weight: var(--weight-card-title); }
  .success { color: var(--color-success-strong); background: var(--color-success-weak); border-color: var(--color-success-soft); }
  .warning { color: var(--color-warning-strong); background: var(--color-warning-weak); border-color: var(--color-warning-soft); }
  .danger { color: var(--color-danger-strong); background: var(--color-danger-weak); border-color: var(--color-danger-soft); }
  .current-badge { color: var(--color-info-strong); background: var(--color-info-soft); border-color: var(--color-focus-ring); }
  .pull-request { display: grid; gap: var(--spacing-md); margin-top: var(--spacing-sm); padding: var(--spacing-lg); background: var(--color-surface-soft); border: 1px solid var(--color-border); border-radius: var(--rounded-xl); }
  .pr-heading { align-items: flex-start; justify-content: space-between; gap: var(--spacing-lg); }
  .pr-heading h2 { margin: .3rem 0 .25rem; font-size: var(--text-card-title); line-height: var(--leading-card-title); }
  .pr-heading p { margin: 0; color: var(--color-ink-muted); font-size: var(--text-caption); }
  .pr-link { display: inline-flex; align-items: center; gap: .35rem; flex: 0 0 auto; padding: .5rem .7rem; color: var(--color-primary); background: var(--color-surface); border: 1px solid var(--color-border-strong); border-radius: var(--rounded-lg); font-size: var(--text-caption); font-weight: var(--weight-card-title); text-decoration: none; }
  .pr-link:hover { border-color: var(--color-primary); }
  .pr-facts { justify-content: space-between; }
  .checks { gap: var(--spacing-xs); }
  .markdown { padding: var(--spacing-md); background: var(--color-surface); border: 1px solid var(--color-border-soft); border-radius: var(--rounded-lg); }
  .diff-details, .technical-details { border-top: 1px solid var(--color-border); }
  summary { cursor: pointer; padding: var(--spacing-sm) 0; color: var(--color-ink-muted); font-size: var(--text-caption); font-weight: var(--weight-card-title); }
  pre { max-height: 22rem; margin: 0; padding: var(--spacing-md); overflow: auto; color: var(--color-code-ink); background: var(--color-code-surface); border-radius: var(--rounded-lg); font-size: var(--text-caption); }
  .technical-details dl { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--spacing-sm); margin: 0; }
  .technical-details dl > div { min-width: 0; padding: var(--spacing-sm); background: var(--color-surface-soft); border-radius: var(--rounded-lg); }
  dt { color: var(--color-ink-subtle); font-size: var(--text-caption); }
  dd { margin: .25rem 0 0; overflow-wrap: anywhere; }
  .worktree-error { color: var(--color-danger-strong); }
  @media (max-width: 720px) { .summary, .pr-heading { align-items: flex-start; flex-direction: column; } .summary-facts { justify-content: flex-start; } .branch-line { align-items: flex-start; flex-direction: column; } .technical-details dl { grid-template-columns: 1fr; } .git-change-preview { padding: var(--spacing-lg); } }
</style>
