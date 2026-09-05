# GPT-6 strategy experiment: no reliable improvement

The completed, comparable run selected `candidate-1` using development data alone.
On holdout it passed **4/10** trials versus **5/10** for the baseline. One task's
pass count fell; four tied. The preregistered machine result is `regressed`, an
observed regression on this suite, not a statistically established general decline.
No strategy is promoted into Spark's production policy. This experiment does not
establish RSI.

The [machine receipt](receipt.json) contains every trial outcome, resource totals,
paired comparison and source identity. [Exact generated strategies](strategies.json)
retain the model's hypotheses and unedited strategy text. The compressed evidence
archive and its 44 trial shards contain all 535 sealed records, including provider
requests/responses, tool traces, independent observations, patches and Evidence refs.

## Frozen design and provenance

The run used Spark's actual agent loop, host, Files tools and authenticated
`openai-codex/gpt-6-astra` provider. It repaired production source in fresh isolated
workspaces. The harness and model defaults were committed before the run; no source,
strategy, budget or acceptance rule changed during scored execution.

| Item | Recorded value |
| --- | --- |
| Run | `strategy-v1-gpt6-r1` |
| Harness commit | `31bde84350ee230ea4d193058baaffd7d9749df7` |
| Task source commit | `35148d273477862dc67040e9a19429c2d5eceaac` |
| Freeze SHA-256 | `9c3057c59cb4478c2959d1b30e49c142260267ef7e8217dadf8df0d9fc70ce0b` |
| Evaluator SHA-256 | `ab52314fa87cbc6e63c50503021a4210b36395f7695955834cfb354c3b208a28` |
| Runtime | Node v24.20.0, macOS 27.0.0, arm64, Apple M5 Pro |
| Freeze / completion, UTC | 2026-09-05 06:57:18.629 / 07:17:05.375 |
| Selection locked, UTC | 2026-09-05 07:07:28.825 |

The [task manifest](../../tasks.json) pins eight historical repair commits and replays
their regression mechanisms on the recorded source commit. These are retrospective
module repair tasks, not whole historical checkouts. Each solver workspace contains
all eight defects and 1,505 production source files, without Git history, tests,
experiment manifests or answers. The development split has three tasks; holdout has
five. All 85 acceptance cases pass on the correct control, and every broken task
fails its relevant witnesses. Host read/write and network denial probes passed.

The [protocol](../../protocol.json) fixes two repetitions per strategy/task, at most
three generated candidates and alternating AB/BA holdout order. Per solver trial:
10 model requests, 24 tool calls, 200,000 provider tokens, 180 seconds, $3 estimated
cost, 65,536 bytes of serialized internal request context and a 2,048-output-token
acceptance ceiling. The reasoning setting is `low`; temperature is omitted and
provider retries are disabled. Generator calls have a separate frozen budget.
The output ceiling is checked after a response because this Codex transport does
not send an output-token limit.

## Development search and selection

| Strategy | Passes | Tokens | Estimated USD | Solver seconds |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 0/6 | 56,359 | 0.562270 | 102.526 |
| Candidate 1 | 0/6 | 39,804 | 0.404480 | 72.924 |
| Candidate 2 | 0/6 | 126,820 | 1.205400 | 164.995 |
| Candidate 3 | 0/6 | 65,406 | 0.610332 | 91.117 |

All 24 development trials failed the same frozen `maxRequestBytes` budget. They
remain in the analysis; there were no silently retried or discarded formal samples.

1. Candidate 1 diagnosed verbose discovery and proposed short source windows,
   ownership confirmation, a compact boundary matrix and earlier verification.
   Its six evaluations still exhausted the request budget.
2. Candidate 2 made the window advice explicit (usually 20–40 lines) and required
   each read to resolve a named uncertainty. Its actual trials still used larger
   reads and did not complete a passing repair within budget.
3. Candidate 3 added a discovery exit rule and unique edit anchors after the
   preceding traces included an edit rejected for matching two occurrences. It
   also failed all six development trials within the unchanged budget.

Spark generated each candidate from development prompts, bounded public tool
traces, failed case identifiers and metrics. Generation had no tools or holdout
answers. No candidate was manually edited. The exact generation responses and
decisions are in `candidates/<id>/` inside the root archive.

All candidates tied at zero passes and met the per-task nonregression condition
against the zero-pass baseline. The preregistered token tie-break selected candidate
1; no eligibility fallback was used. Its lower development token count reflects
earlier failure, so it is not evidence of greater efficiency. Selection was written
before either arm received any holdout task.

## Holdout outcomes

| Task | Baseline passes | Candidate 1 passes | Observation |
| --- | ---: | ---: | --- |
| Cross-realm native errors | 1/2 | 0/2 | Candidate regressed; three runs exhausted the request budget |
| Terminal display width | 0/2 | 0/2 | Baseline patches missed a hidden zero-width case; candidate runs exhausted the request budget |
| SQLite connection scope | 2/2 | 2/2 | Both repaired and passed all independent cases |
| Python request arguments | 2/2 | 2/2 | Both repaired and passed all independent cases |
| Optional argument serialization | 0/2 | 0/2 | All four runs exhausted the request budget |
| Total | **5/10** | **4/10** | One task loss, four ties, zero wins |

The one-sided exact sign test uses task-level pass-count differences, excluding
ties: 0 wins, 1 loss, **p = 1**, alpha 0.05. Repetitions are not counted as independent
tasks. The five purposively chosen holdout tasks provide little statistical power;
the data support no claim of reliable improvement.

Three patches were replayed without model calls against freshly materialized source;
all reproduced the recorded acceptance outcomes. [Replay observations](patch-replays.json):

- `holdout-cross-realm-baseline-r1`: the actual production patch replaces the
  realm-local `instanceof TypeError` check with `isNativeError`; all eight cases pass.
- `holdout-sqlite-scope-candidate-1-r1`: all five SQLite cases pass again.
- `holdout-terminal-width-baseline-r1`: public verification passes, but independent
  acceptance fails `zero-clamped`. The patch uses `truncateToWidth` without clamping
  width to at least one; an empty rendered string fails the expected ellipsis contract.
  This failure remains a failure despite the solver's successful public checks.

## Resources, evidence and limits

| Scope | Tokens | Estimated USD | Solver seconds | Independent grading seconds |
| --- | ---: | ---: | ---: | ---: |
| Development, all four strategies | 288,389 | 2.782482 | 431.562 | 36.435 |
| Three candidate generation calls | 44,592 | 0.525120 | 94.106 | — |
| Holdout baseline | 177,393 | 1.740570 | 266.745 | 5.481 |
| Holdout candidate 1 | 187,643 | 1.832062 | 286.281 | 4.939 |
| Total | **698,017** | **6.880234** | **1,078.694** | **46.855** |

These totals cover 44 solver trials and three strategy generations: 199 model
requests and 254 solver tool calls. Freeze-to-completion elapsed time is 1,186.746
seconds. Costs use provider-reported usage and the frozen catalog; subscription
billing is unavailable (`billedCostUsd: null`). Totals exclude unscored connectivity
and tool canaries, deterministic preflight preparation, later audits and patch replays.
The formal run has 33 budget failures, two other acceptance failures and nine passes,
with no invalid provider, usage, provenance or sandbox samples.

The dominant budget is the byte size of Spark's assembled internal context, including
structured tool metadata and repeated source text. It is not HTTP wire size or the
model's context-window limit. All development strategies reached the same zero-pass
floor, weakening selection. Generated advice also asks for adding tests and package
checks, while the solver surface permits production edits, public `verify` and `diff`;
the system restrictions prevail, but this mismatch can waste its planning budget.
Both are findings for a separately preregistered next experiment, not reasons to
retune or replace this completed negative result.

Other limits: public historical repairs may have appeared in training; task outcomes
may be correlated; the provider exposes neither a seed nor immutable weight revision;
Git/PR command observations use fixed fixtures, while SQLite and filesystem checks
use actual temporary storage. Acceptance concerns these production module contracts,
not whole-service behavior or general coding ability. Hashes establish local artifact
integrity and traceability, not independent attestation of execution.

## Reproduce

With this PR checked out and its dependencies installed, recompute the report offline:

```sh
pnpm experiment:strategy audit-archive experiments/strategy-v1/results/gpt6-r1/evidence.json.gz
```

The root archive binds every compressed trial shard by SHA-256; `receipt.json` binds
the root archive. The portable test audits this complete dataset, compares the full
receipt and readable strategies, and verifies that a missing trial is rejected.

For solver reruns, create a clean worktree at the recorded harness commit, install
the lockfile and use a fresh name. This makes new model calls; nondeterminism means
the recorded outcome is not guaranteed:

```sh
git worktree add --detach ../spark-strategy-reproduce 31bde84350ee230ea4d193058baaffd7d9749df7
cd ../spark-strategy-reproduce
pnpm install --frozen-lockfile
pnpm experiment:strategy prepare strategy-v1-reproduction
pnpm experiment:strategy run strategy-v1-reproduction
pnpm experiment:strategy report strategy-v1-reproduction
```

The [maintainer runbook](../../../../.agents/notes/runbooks/strategy-experiment.md)
documents the macOS isolation requirement, credential setup, archive unpacking and
patch replay. No strategy or model configuration may change after a fresh freeze.
