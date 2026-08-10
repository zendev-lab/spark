# Workbench component provenance

The workbench subpath is a Spark-owned, source-derived implementation. No
registry output, upstream source file, CSS, or visual identity is copied into
this package.

Structural coverage was reviewed against:

- AI Elements component catalog: <https://elements.ai-sdk.dev/components>
- AI Elements Web Preview composition and API:
  <https://elements.ai-sdk.dev/components/web-preview>
- Lobe UI component catalog and design-system documentation:
  <https://ui.lobehub.com/>

Spark's implementation intentionally differs in its protocol-neutral view
types, explicit callback ownership, safe display-only code and preview
surfaces, Svelte API, tokens, and accessibility contracts. In particular,
Spark's preview body keeps an empty iframe sandbox and does not adopt the
upstream live-runtime sandbox permissions, URL state, or console state. When
the reference set or a component's structural provenance changes, update this
file together with the component catalog and tests.
