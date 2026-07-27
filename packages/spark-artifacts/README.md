# spark-artifacts

Product artifacts (`issue` / `pr` / `preview`) for users, plus an **agent-internal evidence ledger** that is not shown in Cockpit.

## Two surfaces

| Surface | Tool | Kinds | User-visible? | On-disk |
|---|---|---|---|---|
| **Product artifacts** | `artifact` | `issue`, `pr`, `preview` | Yes (Cockpit `/artifacts`) | `.spark/artifacts/` |
| **Internal evidence** | `evidence` | `record` (default), `trace`, `knowledge`, `document` | No | `.spark/artifacts/` (compat); `defaultEvidenceStore` can use `.spark/evidence/` |

- ISSUE/PR sync from GitHub (`gh`) or GitLab (`glab`).
- PR create prefers a git worktree under `.spark/worktrees/pr-…`.
- Preview artifacts are continuously updated (version + progress).
- Preview formats are `md`, safe `mdx` (Spark's declarative `mdx-lite`), sanitized `html`, read-only A2UI v0.9.x, and `spark-ui` (`SparkUiDocumentV1` or `mdx-lite` source).
- Cockpit artifact pages embed the safe preview document. `artifact action=open_preview` renders Markdown directly in an attached TUI; other formats require a local Cockpit/browser surface and receive an expiring, tokenized `127.0.0.1` URL. Channel, remote, and headless sessions report the preview as unsupported instead of claiming it opened.
- HTML previews run with scripts, forms, external media, framing, and network loads disabled. A2UI accepts only the official v0.9/v0.9.1 basic catalog and does not dispatch actions in the initial read-only implementation.

Google's GenUI SDK is a Flutter A2UI renderer, so it is not a separate Spark wire format. Web producers should emit `a2ui`; Spark's older declarative format remains available as `spark-ui` for compatibility.

### Evidence (agent-only)

Prefer compact JSON notes:

```json
{ "summary": "one-line fact", "data": { } }
```

Do not write long markdown essays into evidence. Use `artifact` for anything the user should see.

Import Generative UI from `@zendev-lab/spark-artifacts/generative-ui`.
Import product helpers from `@zendev-lab/spark-artifacts/product` or the package root.

- `defaultProductArtifactStore(cwd)` → `.spark/artifacts/` (product kinds only)
- `defaultEvidenceStore(cwd)` → `.spark/evidence/` (+ legacy `.spark/artifacts/` reads)
- `defaultArtifactStore(cwd)` / `evidence` tool → historical evidence root `.spark/artifacts/` (compat with ask/runtime)
