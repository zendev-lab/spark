# Repro Golden Journey

The Repro Golden Journey is the process-level acceptance path for the public
three-lane entrypoint. It proves that `/repro <objective>` starts and continues a
durable workflow through real Spark owners instead of a mocked topology.

This is a product-wiring and recovery contract. It does not measure model
intelligence, numerical accuracy, or GitHub availability.

## User outcome

For `/repro 复现 glm52`, Spark must:

1. accept one Root command;
2. persist one WorkItem and immediately reserve three stable child Sessions;
3. start from a non-Git Workspace containing multiple repositories without selecting one;
4. invoke only Implementation first;
5. advance automatically through five accepted TaskRuns;
6. let lane agents create GitChanges or Drafts only when their concrete work needs them;
7. deliver two forward handoffs and two ordered backward resolutions;
8. survive Root context compaction without replaying launch or replacing a lane
   Session;
9. survive daemon restart with no duplicate Task, TaskRun, Session, Artifact,
   route, receipt, agent-created commit/PR, or Ask; and
10. route lane attention to Root, then resume the original lane Session and
    Workspace checkpoint after a direct user answer.

The durable checkpoint is the Repro owner state plus TaskGraph, TaskRun,
Evidence, optional lane-created Artifacts, and Ask records. Transcript messages
and compact summaries are projections only.

## Canonical checkpoint chain

```text
/repro <objective>
  -> persist work_enqueue intent
  -> reserve Implementation + Exactness + Formalize Sessions in the Workspace
  -> Implementation TaskRun
  -> Exactness TaskRun
  -> Formalize TaskRun
  -> Exactness refresh TaskRun
  -> Implementation refresh TaskRun
  -> completed WorkItem
```

The observable typed routes are:

```text
start_binding
materialize_binding
materialize_binding
refresh_binding
refresh_binding
```

Only Formalize updates `formalizedTip`. The Exactness refresh resolution names
the Formalize resolution, and the Implementation refresh resolution names that
Exactness parent. Implementation and Exactness refreshes reuse their original
Sessions and accept the canonical logical revision. Any repository, GitChange,
commit, or Draft creation remains explicit lane work rather than route behavior.

## Context compaction and continuation

The normal process scenario compacts the Root Session after at least one result
receipt and before all five results are accepted. The real `session.compact`
operation must succeed with a very small recent-token budget and retain a
bounded `work.repro` projection in `session.snapshot`.

The next Root turn must inspect the durable Repro status before continuing. It
must not call start again. Completion must retain exactly five TaskRuns and
three lane Session identities. A final daemon restart must produce zero new
provider requests and zero changes to Task, TaskRun, Artifact, route, receipt,
handoff, or resolution counts.

If compaction itself fails, the failure is a Session presentation failure: it
must not mutate or erase the Repro checkpoint. Focused Session tests own that
atomicity boundary; the Journey proves successful mid-run compaction and
post-compaction continuation through the full chain.

## Root attention and restart

The attention scenario makes the first Implementation TaskRun return a strict
`attention_request`. Spark persists a pending `root_attention` route and exposes
one Ask on the Root Session. The daemon is then restarted before the answer.

After restart, the same Ask id must remain pending. A direct free-form answer is
submitted through the daemon Ask boundary. It creates one `resume_binding`
route, clears the pending Ask, and completes the normal chain. The resulting
route sequence is:

```text
start_binding
root_attention
resume_binding
materialize_binding
materialize_binding
refresh_binding
refresh_binding
```

This scenario has six accepted result receipts: the attention result plus the
normal five-run chain. Implementation therefore has three TaskRuns, all bound
to its original Session. The pending Root Loop used to wake the AnswerEvent is
an existing daemon mechanism, not a fourth Repro lane or coordinator.

## Production boundaries

The Journey uses real implementations for:

- daemon processes, restart, local RPC, and SQLite persistence;
- TaskGraph, Task, TaskRun reservation, and execution Session ownership;
- Repro v9 work items, routes, bindings, receipts, handoffs, and resolutions;
- Ask persistence and AnswerEvent settlement;
- Artifact and Evidence stores;
- a non-Git Workspace containing multiple real local Git repositories without
  launch-time selection; and
- Root context compaction and bounded Session snapshots.

Only nondeterministic external boundaries are substituted:

- model streaming uses the file-backed scripted provider through the normal
  provider registry and model-selection path.

The test must not use in-memory SQLite, direct store mutation to advance the
workflow, or `vi.mock` to replace the production runtime under test. Scripted
provider outputs are accepted only through the same tool, TaskRun, Evidence,
and provenance boundaries as ordinary model output.

## Assertions

The normal scenario requires:

- one Root command and one WorkItem;
- three Tasks and three stable lane Sessions inherited from one non-Git Workspace;
- multiple fixture repositories remain lane-discovered rather than launch-selected;
- five successful TaskRuns distributed as Implementation 2, Exactness 2,
  Formalize 1;
- two forward handoffs and two backward resolutions;
- no launch-created GitChange, commit, or PR;
- mid-run Root compaction followed by a status-first continuation; and
- an idempotent final daemon restart with no durable or provider writes.

The attention scenario requires:

- one pending Root Ask before and after daemon restart;
- one accepted direct-user answer and no remaining Ask;
- one `root_attention` and one `resume_binding` route; and
- the same Implementation Session before attention and after resume.

Focused owner tests retain responsibility for every individual crash window:
enqueue persistence, TaskRun reservation, invocation acceptance,
rejected-then-corrected results, and zero-write repeated reconciliation. Git
materialization and Draft publication are tested by the Artifact owner and by
lane workflows that actually request them; they are not Repro launch windows.
The process Journey proves the owners compose through real process replacement
and compaction.

## Running the proof

```sh
pnpm run test:journey:repro
```

The lane builds the real Hub adapter-node output, creates isolated `HOME`,
`SPARK_HOME`, XDG state, daemon/Hub databases and sockets, provider and forge
ledgers, and a non-Git fixture Workspace with multiple Git repositories. It needs the cue-shell runtime declared by
the Journey configuration. On failure the fixture path is printed and retained
for inspection; successful runs remove it.

Run focused owner checks before the Journey when changing one boundary. Run the
complete Journey at the top of the Repro PR stack and report its actual result;
do not describe mocked component tests as end-to-end proof.
