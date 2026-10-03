# 2026-08-19: Keep DSH Cue integration as a private runtime adapter

## Decision

Add `@zendev-lab/dsh-tool-cue` as a private adapter for exactly DeepSeek
Harness `0.1.0-rc.7`. Keep `@zendev-lab/spark-cue/operations` as the only owner
of Cue tool semantics and external `cued` state. The DSH package owns only the
DSH plugin ABI, current-session permission gate, canonical DSH output schemas,
and replayable presentation.

`spark web` mounts this adapter globally and installs two managed presets,
`spark-standard` and `spark-code`, derived from the pinned rc.7 upstream
presets with `tool-bash`, `tool-pwsh`, and `tool-jobs` removed. Upstream presets
remain available, but only the Spark presets promise Cue-first execution.

## Boundaries

- DSH sessions map to Cue session ids as `dsh:<session.id>`; DSH does not become
  the Cue job or session owner.
- Cue calls require the session's current policy to resolve to
  `danger-full-access`. This is a fail-closed policy gate, not a claim that the
  external daemon is covered by DSH file sandboxing.
- DSH approval is not used. The existing `tools/pre-execute` policy and a
  monotonic missing-Agent guard run before the operation layer.
- SSH profiles require an explicit remote cwd and never reuse the local session
  cwd or auto-start a remote daemon.
- Preset source digests and exact DSH package metadata are verified before
  managed writes. Unmarked or user-modified preset directories are never
  overwritten.

## Package budget

The DSH runtime is a hard host ABI, permission, presentation, and lifecycle
boundary. That justifies one private adapter package and raises the closed
package budget from 43 to 44 without moving Cue semantics out of their existing
owner.
