<script lang="ts">
  import type { CockpitMemoryQuarantineDetail } from "./memory-proposal-detail";

  let { detail }: { detail: CockpitMemoryQuarantineDetail } = $props();
</script>

<section class="quarantine-card" aria-label="Memory quarantine lifecycle">
  <header>
    <div>
      <p class="eyebrow">Memory quarantine</p>
      <h2>{detail.operation} · {detail.status}</h2>
    </div>
    <span class:incomplete={detail.tombstoneStatus === "purge_incomplete"}>
      {detail.tombstoneStatus}
    </span>
  </header>

  <dl>
    <div><dt>Artifact</dt><dd>{detail.artifactRef}</dd></div>
    <div><dt>Manifest digest</dt><dd><code>{detail.manifestDigest}</code></dd></div>
    <div><dt>Plan digest</dt><dd><code>{detail.planDigest}</code></dd></div>
    <div><dt>Purge after</dt><dd>{detail.purgeAfter}</dd></div>
  </dl>

  <h3>Target receipts</h3>
  <ul>
    {#each detail.targetReceipts as receipt (receipt.targetId)}
      <li>
        <div><strong>{receipt.kind}</strong><code>{receipt.targetId}</code></div>
        <span class:failed={receipt.status === "failed"}>{receipt.status}</span>
        {#if receipt.error}<p>{receipt.error}</p>{/if}
      </li>
    {/each}
  </ul>

  {#if detail.remainingTargets.length > 0}
    <p class="remaining">Remaining targets: {detail.remainingTargets.join(", ")}</p>
  {/if}
</section>

<style>
  .quarantine-card { display: grid; gap: 1rem; padding: 1rem; border: 1px solid var(--border-subtle, #d7dde7); border-radius: .75rem; background: var(--surface-raised, #fff); }
  header, li, dl div { display: flex; justify-content: space-between; gap: 1rem; align-items: start; }
  .eyebrow { margin: 0; color: var(--text-muted, #64748b); font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 1rem; }
  h3 { font-size: .875rem; }
  header > span, li > span { padding: .15rem .45rem; border-radius: 999px; background: #dcfce7; color: #166534; font-size: .75rem; }
  header > span.incomplete, li > span.failed { background: #fee2e2; color: #991b1b; }
  dl, ul { display: grid; gap: .5rem; margin: 0; padding: 0; }
  dt { color: var(--text-muted, #64748b); }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  li { display: grid; grid-template-columns: minmax(0, 1fr) auto; padding: .6rem; border-radius: .5rem; background: var(--surface-subtle, #f8fafc); list-style: none; }
  li div { display: grid; gap: .15rem; min-width: 0; }
  li p { grid-column: 1 / -1; color: #991b1b; }
  code { font-size: .75rem; overflow-wrap: anywhere; }
  .remaining { color: #991b1b; font-size: .8rem; }
</style>
