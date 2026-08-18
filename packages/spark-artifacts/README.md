# spark-artifacts

Atomic Artifacts (`issue` / `git_change` / `document`) for users, plus an
**agent-internal evidence ledger** that is not shown in Hub.

## Two surfaces

| Surface | Tool | Kinds | User-visible? | On-disk |
| --- | --- | --- | --- | --- |
| **Artifacts** | `artifact`, `git` | `issue`, `git_change`, `document` | Yes (Hub `/artifacts`) | `.spark/artifacts/` |
| **Internal evidence** | `evidence` | `record` (default), `trace`, `knowledge`, `document` | No | `.spark/evidence/` |

- `issue` represents a forge issue.
- `git_change` contains one owning worktree and one native GitHub PR stack.
  Stack layers are child entries, not separate Artifact refs. `git({ action })`
  owns init, checkout/adopt, layer, commit, refresh, submit, sync, and cleanup.
  Managed paths and legacy compatibility are specified in
  [`.agents/notes/contracts/tools.md`](../../.agents/notes/contracts/tools.md); new worktrees use
  `<workspace-root>/.agents/worktrees/<owner>/<repo>/<semantic-name>`.
- `gh stack` is the sole writable topology authority. Submissions are draft by
  default; Spark does not add routine PR comments or boilerplate saying a PR
  is stacked/tested.
- `document` owns typed content, revision, and optional progress. Preview is a
  view opened with `artifact({ action: "open_preview" })`, not an Artifact
  kind.
- New Document writes accept only `text/markdown`, `text/mdx`, `text/html`,
  and `application/vnd.a2ui+json`. Plain-text, JSON, unknown media types, and
  the removed Spark UI wire format cannot be created or previewed.
- `artifact({ action: "sync_file" })` updates an existing Document from a
  cwd-local regular, non-symlink UTF-8 file. The first report slice is capped
  at 32 KiB. A repeated identical sync is a no-op; metadata-only changes keep
  the content revision, while content or media-type changes advance it.
- Hub artifact pages embed safe document views. Markdown can render in an
  attached TUI; other supported media receive an expiring, tokenized
  `127.0.0.1` URL only on a local browser-capable surface.
- HTML previews run with scripts, forms, external media, framing, and network
  loads disabled. The shared protocol normalizer accepts only the official A2UI
  v0.9/v0.9.1 basic catalog; Artifact preview remains read-only and never
  dispatches actions.
- Daemon-managed Workbench Documents use compare-and-set revisions and a stable
  binding. A live binding may advance only from its expected revision; sealed
  Documents reject every later overwrite. Internal condition and reviewer
  receipts remain Evidence refs and are not promoted to Artifact kinds.

Google's GenUI SDK is a Flutter A2UI renderer, so it is not a separate Spark
wire format. Web producers should emit `a2ui`. `spark-ui` now names the Svelte
component library only and is not an Artifact format.

Persisted v1 `pr` and `preview` bodies are accepted read-only and lazily
normalized to `git_change` and `document` with the same `artifact:` ref.
Canonical writes are v2 only; there is no destructive bulk migration.

### Evidence (agent-only)

Prefer compact JSON notes:

```json
{ "summary": "one-line fact", "data": { } }
```

Do not write long markdown essays into evidence. Use `artifact` for anything the user should see.

Import Artifact helpers from `@zendev-lab/spark-artifacts/artifact` or the package root.

- `defaultArtifactStore(cwd, ctx?)` → workspace Spark state `artifacts/` (Artifact kinds only)
- `defaultEvidenceStore(cwd, ctx?)` → workspace Spark state `evidence/` and `evidence:…` refs only

The two surfaces are not aliases. The `evidence` tool never scans
`.spark/artifacts/`, never accepts an `artifact:…` ref, and never publishes
ledger entries as Artifacts. Legacy evidence under `.spark/artifacts/`
requires an explicit migration/import path.
