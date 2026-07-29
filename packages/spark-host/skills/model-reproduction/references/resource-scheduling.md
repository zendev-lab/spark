# Resource Scheduling

Read this reference before dispatching a parallel Task wave.

Project Task dispatch belongs to `assign`; specialized workflows may fan out
bounded work inside one Task but must not create a second Task scheduler.

Each Task declares continuity, isolation, comparison side, per-side GPU count,
minimum GPU memory, topology class, node exclusivity, concurrency keys, timeout,
and max attempts. Treat paired GPU count as per side:

```text
8 GPUs -> 8 single-side 1-GPU jobs
8 GPUs -> 4 paired 1+1 lanes
8 GPUs -> 2 paired 2+2 lanes
8 GPUs -> 1 paired 4+4 lane
8-GPU Reference and Target profiles -> serial unless 16 GPUs exist
```

Use isolated worktrees for implementation and isolated results namespaces for
experiments. Reconstruct leases from queued/running TaskRuns after restart.
Release a lease only after the child invocation is terminal; on timeout request
cancellation first. Bound retries and surface the blocker after the limit.
Performance runs require an exclusive node.
