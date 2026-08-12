# Svelte AI Elements model selector provenance

- Upstream: <https://github.com/SikandarJODD/ai-elements>
- Upstream commit: `fa4bc217f84bc571378bc371332a154106772614`
- Relationship: upstream describes itself as an unofficial Svelte port of Vercel AI Elements
- Original registry: <https://svelte-ai-elements.vercel.app/r/model-selector.json>
- Original files: `src/lib/components/ai-elements/model-selector/*`
- License: MIT; retained in `UPSTREAM-LICENSE.txt`
- Imported: 2026-07-13
- Last reviewed upstream commit: `fa4bc217f84bc571378bc371332a154106772614`

## Local changes

The reusable model picker now lives in `@zendev-lab/spark-ui/conversation` as
`ModelSelector`. Hub retains `ModelRuntimeControl.svelte` as the product adapter
that binds provider catalog facts, Spark thinking levels, settings routes, and
SvelteKit forms.

- Kept the upstream searchable Dialog + Command interaction, implemented on the supported Bits UI
  primitives and Spark design tokens.
- Replaced upstream model/provider shapes with the small, protocol-neutral
  `ConversationModelGroup` presentation contract.
- Removed AI SDK, Tailwind, shadcn-svelte runtime, and `models.dev` logo requests.
- Uses local monograms so Hub remains useful without external UI assets.
- Leaves provider authentication, catalog truth, session model changes, and
  SvelteKit form submission in the owning Hub route and Spark daemon.

Review upstream manually and port useful behavior deliberately. Do not run the registry installer over
this directory.
