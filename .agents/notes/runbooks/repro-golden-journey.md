# Repro v10 Golden Journey

This runbook describes the deterministic required Journey and the separate live
model capability gate. They prove different things and must not be conflated.

## Required deterministic Journey

Run:

```sh
pnpm run test:journey:repro
```

The test calls the real `repro.start` daemon RPC used by the `/repro` command
handler. It does not ask a scripted Root model to translate command text into a
tool call.

The fixture uses:

- real daemon processes and SQLite;
- the real Session registry, TaskGraph, Evidence and Artifact stores;
- Hub registration and browser-facing projections;
- a non-Git Workspace root containing two real Git repositories;
- a forge shim that fails the test if Repro creates a PR;
- a deterministic scripted lane provider;
- daemon restart and real Session compaction.

The scripted provider is a deterministic protocol fixture, not evidence that a
real model can choose the right repositories, tools, or reproduction method.

A passing normal scenario proves:

- one direct Root start;
- three visible child lane Sessions;
- one inherited-and-frozen model per lane without
  `role-model-settings.json`;
- three Tasks and five successful TaskRuns;
- Session reuse for both refresh checkpoints;
- fixed checkpoint ordering and Formalize-only revision progress;
- strict TaskRun-bound Evidence;
- one report Document and one Workbench Document;
- no Git-cwd assumption and no forge mutation;
- compaction continuation and daemon restart;
- a final reconcile/restart with zero durable or provider writes.

The attention scenario proves:

1. Implementation returns `attention_request`.
2. The daemon creates one Root-owned Ask.
3. Daemon restart preserves the Ask and all three lane Sessions.
4. A direct-user answer records AnswerEvent Evidence.
5. Implementation creates attempt 2 in the same Session.
6. The fixed five-checkpoint chain then completes.
7. Implementation has three Runs total: attention, resumed implementation, and
   implementation refresh.

On failure, the retained temporary fixture contains daemon logs, provider
ledger, SQLite, Session JSONL, TaskGraph, Evidence, Artifacts, and both Git
repositories. Diagnose those sources; do not replace the process Journey with
mocked `persist`, `dispatch`, or `ensureGitChange` calls.

## Live model capability gate

Run only where configured model credentials and the isolated capability
environment are available:

```sh
pnpm run test:capability:repro-live
```

This Nightly and release gate uses the same direct start and a small
multi-repository reproduction, but allows a real configured model to discover
repositories, follow the three Role instructions, choose tools, attach strict
Evidence, survive forced compaction, and finish all checkpoints. It is not a
normal pull-request required check because it is credentialed and
model-dependent. Its latest passing result is required before release.

GitHub Actions requires the repository variable `SPARK_REPRO_LIVE_MODEL` in
`provider/model` form and the matching repository or organization provider
secret exposed to the workflow. The checked-in workflows currently forward
`OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Missing configuration and scripted
providers fail closed; they do not turn this capability gate into a skipped or
passing run.

A scripted Journey pass does not substitute for this gate. A live capability
pass also does not substitute for deterministic migration, serialization,
provenance, crash-window, or idempotency tests.
