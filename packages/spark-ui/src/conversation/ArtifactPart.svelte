<script lang="ts">
  import { Artifact } from "../workbench";

  type Props = {
    artifactRef: string;
    title: string;
    kind?: string;
    state?: string;
    summary?: string;
    previewHref?: string;
    previewLabel: string;
    statusLabel: (status: string) => string;
  };

  let { artifactRef, title, kind, state, summary, previewHref, previewLabel, statusLabel }: Props = $props();
</script>

<Artifact
  view={{ id: artifactRef, title, kind, status: state, summary, previewHref }}
  {previewLabel}
  {statusLabel}
/>
