# Workbench component provenance

The workbench subpath is a Spark-owned, source-derived implementation. No
registry output, upstream source file, CSS, or visual identity is copied into
this package.

Structural coverage was reviewed against:

- AI Elements component catalog: <https://elements.ai-sdk.dev/components>
- Lobe UI component catalog and design-system documentation:
  <https://ui.lobehub.com/>

Spark's implementation intentionally differs in its protocol-neutral view
types, explicit callback ownership, safe display-only code and preview
surfaces, Svelte API, tokens, and accessibility contracts. When the reference
set or a component's structural provenance changes, update this file together
with the component catalog and tests.
