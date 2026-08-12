# Repro Golden Journey

The Repro Golden Journey is the authoritative product-level acceptance path for a
small, deterministic reproduction task. It proves that the independently tested
Repro, Ask, Loop, Session, invocation, Git delivery, Artifact, report, and Hub
projection capabilities are connected into one usable workflow.

This contract is intentionally narrower than a benchmark. It verifies product
wiring, durable state transitions, recovery, evidence provenance, and delivery. It
does not measure model intelligence or numerical performance.

## User outcome

A user can:

1. start a Repro from one objective;
2. receive one blocking, canonical decision request;
3. restart the daemon without losing that request;
4. answer through a supported product surface;
5. let the same Repro resume and repair a deterministic defect;
6. receive a validated `git_change` Artifact and Draft PR;
7. receive a stable Repro report Document with durable Evidence;
8. observe the Repro complete and its Workbench seal.

The complete path must run without live model tokens or a real GitHub repository.
It uses production code for Spark-owned behavior and deterministic substitutes only
at external nondeterministic boundaries.

## Canonical journey

```text
user objective
  -> Session / Goal / Repro / Loop created by the daemon
  -> scripted provider drives the real AgentLoop and public tools
  -> canonical Ask is persisted
  -> Repro becomes waiting_decision and automatic work stops
  -> daemon restarts
  -> user answer is submitted through the public interaction boundary
  -> the same Repro resumes exactly once
  -> a managed git worktree is changed and validated
  -> Evidence records the failing baseline and passing repair
  -> git_change is committed and submitted as one Draft PR
  -> typed Repro summary and Markdown report are projected
  -> the stable report Artifact is synchronized
  -> trusted completion evaluation closes the Repro
  -> Workbench lifecycle becomes sealed
```

## Deterministic boundaries

The process journey must retain real implementations for:

- daemon process and SQLite persistence;
- local RPC and protocol decoding;
- Session, Goal, Repro, Loop, and InvocationScheduler state;
- AgentLoop and tool dispatch;
- Ask persistence and answer settlement;
- file edits, Git repository, worktree, and commit;
- Evidence and Artifact stores;
- report projection and synchronization;
- Hub/Workbench projection where the tested surface participates.

Only these external boundaries may be substituted:

- model streaming: `createSparkScriptedProvider` through the normal provider
  registry and model-selection path;
- forge operations: a deterministic `gh stack`/GitHub shim while retaining real
  local Git operations;
- clock and id sources where deterministic assertions require them.

A process-level Golden Journey must not use an in-memory SQLite database, call
store mutation methods directly, or replace the production component under test
with `vi.mock`.

## Source-process lane

Run the authoritative happy path with:

```sh
pnpm run test:journey:repro
```

The command requires a cue-shell runtime that advertises IPC protocol v2 and the
`session-handshake-required` capability. The dedicated Ubuntu CI lane builds the
runtime from the immutable source revision declared in `ci-tests.yml`; this native
dependency intentionally stays outside `prek` and the default local `pnpm run check` gate.

The root journey and source-process scripts build the real Hub adapter-node output
before starting processes, so the same lane works from a clean checkout without
relying on stale local build artifacts.

The lane creates an isolated `HOME`, `SPARK_HOME`, XDG state, Hub database,
daemon database and socket, local port, provider ledger, forge ledger, and
fixture Git repository. The file-backed provider plugin is loaded through the
normal provider registry and active-model selection path. Zero-tool auxiliary
requests, such as compaction, are recorded separately and do not advance the
Journey cursor.

The first Ask opens asynchronously so the daemon can restart while the durable
request is pending. The test answers it through `spark daemon ask answer`, then
replays the same response over public local RPC to prove idempotency. A blocking
replay with the same owning Session and stable `toolCallId` reattaches to the
settled request and records the canonical Ask Evidence; mutable `flow` text is
not replay identity and no second decision row is inserted. The isolated
reviewer model setting routes Git external-write review through the same
scripted provider, which returns a valid structured approval without advancing
the main Journey cursor or creating a second human request. The test fails
closed if a tool-approval Ask appears.

Local Git remains real. The forge shim replaces only `gh stack`/GitHub network
operations and records exactly one Draft PR. The typed summary is compared with
the canonical JSON embedded in the Markdown projection, every accepted formal
gate must carry Evidence, two report synchronizations converge on one stable
Document Artifact ref, and the terminal assertions require a sealed Workbench,
no pending interaction, no active invocation, and no live Hub or daemon PID.

The source dispatcher must preserve Node IPC while forwarding daemon lifecycle
commands. Otherwise the daemon-owned restart helper cannot transfer ownership
to its successor when the test runs from source.

## Minimal alignment fixture

`test/fixtures/repro/minimal-alignment` is the canonical first task. It contains:

- a runnable reference implementation;
- a target implementation with one localized normalization defect;
- immutable test vectors and expected outputs;
- a zero-dependency verifier that fails before the repair and passes after the
  reference formula is applied to the target.

The fixture is deliberately small enough for every pull request and expressive
enough to exercise the real Repro phases:

| Repro stage | Fixture proof |
| --- | --- |
| `contract` | objective and acceptance criteria are frozen |
| `reference` | `node verify.mjs reference` passes |
| `target` | `node verify.mjs target` fails before repair |
| `alignment` | the target formula is repaired and verification passes |
| `delivery` | commit, Draft PR, report, and Evidence refs are durable |

Do not weaken the fixture by making the verifier derive expected values from the
implementation under test. Expected outputs are immutable test data.

## Required milestones

The final process test must derive or observe this ordered trace from production
state and receipts:

```text
repro.started
decision.requested
decision.persisted_across_restart
decision.answered
repro.resumed
validation.failed_before_fix
validation.passed_after_fix
git_change.committed
pull_request.submitted
report.projected
report.synced
repro.completed
workbench.sealed
```

Each milestone must:

- occur exactly once;
- carry the same `reproId`;
- appear in the declared order;
- be backed by a durable state transition, Artifact, Evidence receipt, or forge
  ledger entry rather than a test-only boolean.

## Acceptance assertions

The completed Golden Journey must prove all of the following:

- one Session, Repro, and owning Loop are created;
- waiting for the Ask does not consume further provider rounds;
- the pending Ask survives daemon restart;
- duplicate answer delivery is idempotent and a conflicting answer fails closed;
- the repair occurs only in the managed `git_change` worktree;
- verification fails before the repair and passes afterward;
- one commit and one Draft PR are created;
- recovery cannot create a duplicate commit or PR;
- accepted formal gates reference durable Evidence;
- `outputs/spark-summary.json` and `outputs/report.md` agree;
- the stable report Artifact ref is unchanged across idempotent synchronization;
- trusted evaluation, not model narration, completes the Repro;
- no invocation, pending decision, or writable Workbench remains after completion.

## CI position

The final shape is:

```text
test:capability          fast severe-regression sentinels
test:journey:repro      authoritative complete Repro product path
test:process:source     executable lifecycle and dispatch contracts
smoke                   packed public product lifecycle
test:mutation           sensitivity of focused owner tests
```

The journey lane should initially run once on relevant pull requests. Repetition,
flake classification, and duration variance belong in a separate non-blocking CE
lane after the deterministic happy path is stable. Its external cue-shell runtime is
provisioned only in this lane; the ordinary source-process matrix remains hermetic.
