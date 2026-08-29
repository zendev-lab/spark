<script lang="ts">
  import { brandIconMap, type BrandIconName } from "./brand-icons";

  export let name: BrandIconName;
  export let size = 20;

  $: icon = brandIconMap[name];
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="currentColor"
  aria-hidden="true"
  focusable="false"
>
  <path d={icon.path} />
</svg>
