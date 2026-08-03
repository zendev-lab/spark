# spark-artifacts

Atomic Artifacts (`issue` / `git_change` / `document`) for users, plus an
**agent-internal evidence ledger** that is not shown in Cockpit.

## Two surfaces

| Surface | Tool | Kinds | User-visible? | On-disk |
|---|---|---|---|---|
| **Artifacts** | `artifact`, `git` | `issue`, `git_change`, `document` | Yes (Cockpit `/artifacts`) | `.spark/artifacts/` |
| **Internal evidence** | `evidence` | `record` (default), `trace`, `knowledge`, `document` | No | `.spark/evidence/` |

- `issue` represents a forge issue.
- `git_change` contains one owning worktree and one native GitHub PR stack.
  Stack layers are child entries, not separate Artifact refs. `git({ action })`
  owns init, checkout/adopt, layer, commit, refresh, submit, sync, and cleanup.
  Managed worktrees live under
  `~/.agents/worktrees/<forge>/<owner>/<repo>/<artifact-id>`.
- `gh stack` is the sole writable topology authority. Submissions are draft by
  default; Spark does not add routine PR comments or boilerplate saying a PR
  is stacked/tested.
- `document` owns typed content, revision, and optional progress. Preview is a
  view opened with `artifact({ action: "open_preview" })`, not an Artifact
  kind.
- Cockpit artifact pages embed safe document views. Markdown can render in an
  attached TUI; other supported media receive an expiring, tokenized
  `127.0.0.1` URL only on a local browser-capable surface.
- HTML previews run with scripts, forms, external media, framing, and network loads disabled. A2UI accepts only the official v0.9/v0.9.1 basic catalog and does not dispatch actions in the initial read-only implementation.

Google's GenUI SDK is a Flutter A2UI renderer, so it is not a separate Spark wire format. Web producers should emit `a2ui`; Spark's older declarative format remains available as `spark-ui` for compatibility.

Persisted v1 `pr` and `preview` bodies are accepted read-only and lazily
normalized to `git_change` and `document` with the same `artifact:` ref.
Canonical writes are v2 only; there is no destructive bulk migration.

### Evidence (agent-only)

Prefer compact JSON notes:

```json
{ "summary": "one-line fact", "data": { } }
```

Do not write long markdown essays into evidence. Use `artifact` for anything the user should see.

Import Generative UI from `@zendev-lab/spark-artifacts/generative-ui`.
Import Artifact helpers from `@zendev-lab/spark-artifacts/artifact` or the package root.

- `defaultArtifactStore(cwd)` → `.spark/artifacts/` (Artifact kinds only)
- `defaultEvidenceStore(cwd)` → `.spark/evidence/` and `evidence:…` refs only

The two surfaces are not aliases. The `evidence` tool never scans
`.spark/artifacts/`, never accepts an `artifact:…` ref, and never publishes
ledger entries as Artifacts. Legacy evidence under `.spark/artifacts/`
requires an explicit migration/import path.
