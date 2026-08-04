<script lang="ts">
  import type { CockpitMemoryProposalDetail } from "$lib/memory-proposal-detail";

  let { proposal }: { proposal: CockpitMemoryProposalDetail } = $props();

  const shortDigest = (value: string) => `${value.slice(0, 12)}…${value.slice(-8)}`;
</script>

<section class="memory-proposal" aria-labelledby="memory-proposal-title">
  <header>
    <div>
      <p class="eyebrow">Memory · {proposal.operation}</p>
      <h2 id="memory-proposal-title">Immutable lineage proposal</h2>
    </div>
    <span class="status">{proposal.status}</span>
  </header>

  <dl class="proposal-meta">
    <div><dt>Risk</dt><dd>{proposal.risk}</dd></div>
    <div><dt>Expected revision</dt><dd>{proposal.expectedRevision}</dd></div>
    <div><dt>Proposal digest</dt><dd title={proposal.proposalDigest}>{shortDigest(proposal.proposalDigest)}</dd></div>
    <div><dt>Artifact</dt><dd>{proposal.previewRef}</dd></div>
    <div><dt>Conflict</dt><dd>{proposal.conflictStatus ?? "none"}</dd></div>
  </dl>

  <div class="diff-grid" aria-label="Memory proposal before and after diff">
    <section>
      <h3>Before</h3>
      {#each proposal.diff.before as source}
        <article>
          <strong>{source.recordRef}</strong>
          <span>{source.revisionRef}</span>
          <code title={source.contentDigest}>{shortDigest(source.contentDigest)}</code>
        </article>
      {/each}
    </section>
    <section>
      <h3>After</h3>
      <article>
        <strong>{proposal.diff.after.recordRef}</strong>
        <span>target current revision</span>
        <code title={proposal.diff.after.contentDigest}>{shortDigest(proposal.diff.after.contentDigest)}</code>
      </article>
    </section>
  </div>

  <section class="lineage" aria-label="Memory lineage and evidence">
    <h3>Lineage</h3>
    <p>{proposal.lineage.sources.length} source revision(s) → {proposal.lineage.targetRecordRef}</p>
    <div class="chips">
      {#each proposal.evidenceRefs as evidenceRef}<span>{evidenceRef}</span>{/each}
    </div>
  </section>

  <p class="approval-note">Approval and cancellation remain in the owning session’s Ask panel.</p>
</section>

<style>
  .memory-proposal { border: 1px solid var(--color-border); border-radius: var(--rounded-lg); display: grid; gap: var(--spacing-lg); padding: var(--spacing-xl); }
  header { align-items: center; display: flex; gap: var(--spacing-md); justify-content: space-between; }
  h2, h3, p { margin: 0; }
  .eyebrow { color: var(--color-primary); font-size: var(--text-caption); font-weight: var(--weight-caption-medium); }
  .status, .chips span { background: var(--color-primary-weak); border-radius: var(--rounded-full); color: var(--color-primary); font-size: var(--text-caption); padding: 5px 9px; }
  .proposal-meta { display: grid; gap: var(--spacing-sm); grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; }
  .proposal-meta div { background: var(--color-surface-soft); border-radius: var(--rounded-md); display: grid; gap: var(--spacing-xxs); min-width: 0; padding: var(--spacing-sm); }
  dt { color: var(--color-ink-subtle); font-size: var(--text-caption); }
  dd { margin: 0; overflow-wrap: anywhere; }
  .diff-grid { display: grid; gap: var(--spacing-md); grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .diff-grid section, .lineage { background: var(--color-surface-soft); border-radius: var(--rounded-md); display: grid; gap: var(--spacing-sm); padding: var(--spacing-md); }
  article { display: grid; gap: var(--spacing-xxs); min-width: 0; }
  article span, .lineage p, .approval-note { color: var(--color-ink-subtle); }
  article strong, article span, code { overflow-wrap: anywhere; }
  .chips { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); }
  .approval-note { border-top: 1px solid var(--color-border-soft); padding-top: var(--spacing-md); }
  @media (max-width: 760px) { .proposal-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); } .diff-grid { grid-template-columns: 1fr; } }
</style>
