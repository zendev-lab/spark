<script lang="ts">
  import LoginPage from "$lib/LoginPage.svelte";

  let { data, form } = $props();
  let copy = $derived(data.messages.login);
</script>

<LoginPage
  available={data.cockpitAccessAvailable}
  {copy}
  errorMessage={form?.message}
  lede={copy.lede}
  next={data.next}
/>
