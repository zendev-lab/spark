# Continuous Delivery

Read this reference while planning every stage, not only Finalize.

Maintain one owner-repository Draft PR per changed repository and one canonical
report. Create the first Draft PR after the first buildable, smoke-tested,
reviewable slice. Synchronize after:

- plan revision;
- accepted patch;
- formal gate pass;
- blocker change;
- profile qualification;
- stage advance;
- review finding change.

Generate managed report and PR sections deterministically from canonical
Project, TaskRun, evidence, commit, config, and PR refs. Preserve unsupported,
rejected, blocked, and inconclusive claims. Role narration is never a source of
truth.

Only the owner delivery Task may commit, push, or mutate the forge. Finalize
does not create the first PR; it resolves review findings, verifies cross-repo
order and CI, marks ready, and freezes the report/evidence bundle.
