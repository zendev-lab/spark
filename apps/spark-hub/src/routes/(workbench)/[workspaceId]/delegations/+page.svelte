<script lang="ts">
  import WorkspaceDelegationsPage from "$lib/WorkspaceDelegationsPage.svelte";
  let { data } = $props();
</script>

<WorkspaceDelegationsPage
  delegations={data.delegations}
  workspaces={data.workspaces}
  authorizedWorkspaceId={data.authorizedWorkspaceId}
  audits={data.audits}
  messages={data.messages.delegations}
/>
