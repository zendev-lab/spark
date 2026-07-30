<script lang="ts">
  import LoginPage from "$lib/LoginPage.svelte";

  let { data, form } = $props();
  let copy = $derived(data.messages.workspaceLogin);
</script>

<LoginPage
  available={data.workspaceAccessAvailable}
  {copy}
  errorMessage={form?.message}
  lede={copy.lede.replace("{workspace}", data.workspaceName)}
  next={data.next}
/>
