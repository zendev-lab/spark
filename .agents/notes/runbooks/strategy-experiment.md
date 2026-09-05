# Model-driven strategy experiment

The authoritative inputs are in [strategy-v1](../../../experiments/strategy-v1/README.md).
The orchestrator is [experiment.mts](../../../scripts/strategy-experiment/experiment.mts);
[audit.mts](../../../scripts/strategy-experiment/audit.mts) verifies evidence and recomputes
acceptance/selection/statistics. This is an explicit maintainer experiment, not a daemon
scheduler or an automatically installed learning policy.

## Run a fresh experiment

Use an independent, clean worktree containing the committed harness. Install the pinned
dependencies with `pnpm install --frozen-lockfile`. The frozen execution backend needs
macOS, `sandbox-exec`, and Node 24 or newer; the reference run uses Homebrew Node. Other
platforms fail closed. CI exercises portable contracts; macOS runs the actual sandbox
boundary/timeout test and every formal experiment probes it again.

Configure Spark's `openai-codex` credential through the normal Spark provider login on
the executing account. The experiment resolves it through Spark provider control. It
never puts a credential in task workspaces or evidence. No credential means no scored
run; offline artifact audits remain available.

```sh
pnpm experiment:strategy prepare strategy-v1-r1
pnpm experiment:strategy run strategy-v1-r1
pnpm experiment:strategy report strategy-v1-r1
pnpm experiment:strategy replay strategy-v1-r1 development-pr-checks-baseline-r1
pnpm experiment:strategy export strategy-v1-r1 reports/strategy-export-r1
pnpm experiment:strategy audit-archive reports/strategy-export-r1/evidence.json.gz
```

`prepare` refuses dirty source, creates both source controls, validates every case and
probes host read/write/network denial before writing `freeze.json`. The source identity
reuses the #615 capability-CE snapshot: commit, evaluator/dependency hashes and environment.
Each trial starts from the same source inventory; the evaluator also runs after the model
finishes, independently of whether the solver invoked public `verify`.

`run` records the development baseline, then at most three model-generated candidates.
Only development prompts, bounded public tool traces, failed acceptance identifiers and
resource metrics reach the generator. Previous candidates and their development feedback
can inform the next candidate. A candidate is text, with no tools during generation.
Selection is locked on disk before *either arm* runs any holdout task. The holdout order
alternates baseline/candidate and candidate/baseline within task repetitions.

All writes to named receipts are exclusive. Re-running `run` on a started experiment
fails rather than silently retrying a crashed sample. If infrastructure fails, preserve
that directory and its error output, fix the cause and use a separately named run. Do not
edit the frozen code, tasks, tests, model/config or strategies during a run. Budget
failures remain failed trials; provider failures, missing usage and provenance drift
make the experiment invalid. Neither discarded samples nor post-holdout tuning are
permitted.

## Review and reproduce evidence

Receipts live in gitignored `reports/strategy-experiments/<name>`. Source snapshots and
solver workspaces live under `.spark/strategy-experiments/<name>` so generated repository
copies cannot pollute repository-wide documentation scans. `seal.json` binds
raw files; `completed.json` binds the full ordered sample inventory; each trial binds its
source, strategy, provider usage, patch, grader results and a Spark Evidence ref. The
offline audit checks hashes, exact trial inventory, fixed model/options, raw provider
usage/cost, source changes, frozen acceptance outputs, development-only selection and
time boundaries. A failed audit emits `comparable: false` and exits nonzero. Hashes provide
integrity and traceability, not third-party cryptographic attestation of local execution.

Export only a completed, audited experiment. Review the archive for credentials and
unrelated content before copying the export directory under `experiments/strategy-v1/results`.
The export workflow explicitly treats these compressed raw records as a reproducibility
source dataset. It excludes source workspace copies and exploratory canaries. The root archive binds one compressed shard per trial, keeping individual files small. It
retains provider request/response objects, tool events, patches and observation stdout;
access keys are redacted before serialization. Local absolute paths and provider response
IDs remain to support traceability.

To rerun the solver, check out the `source.commitSha` in the receipt, install its lockfile,
and use a fresh experiment name. New calls can differ because the provider offers neither
a seed nor an immutable server weight revision. To replay a patch, use the recorded harness
commit and the `replay` command; no model credential is needed. Archive audits require no
sandbox, credentials or model calls. An archive can be unpacked with `unpackExperiment`
from `audit.mts` for patch replay under its recorded harness.

For example, from the harness worktree, unpack an exported dataset into a fresh
receipt directory and replay one recorded patch (replace the archive's absolute path):

```sh
node --experimental-strip-types --input-type=module -e '
const { unpackExperiment } = await import("./scripts/strategy-experiment/audit.mts");
await unpackExperiment(process.argv[1], process.argv[2]);
' /absolute/path/to/export/evidence.json.gz reports/strategy-experiments/replay-gpt6-r1
pnpm experiment:strategy replay replay-gpt6-r1 holdout-cross-realm-baseline-r1
```

## Interpret results

Only complete comparable data can support the preregistered improvement result. Report
per-task regressions and paired repetitions, not just aggregate wins. The task-level exact
sign test does not treat repetitions as independent tasks. Even a passing diagnostic is
limited by eight purposively chosen, potentially correlated tasks from one repository and
possible model training exposure to public historical fixes.

Tokens are provider-reported. Dollar costs are estimates using the frozen catalog;
subscription billing is unknown (`null`). This Codex backend omits temperature and does
not send an output-token limit, so the frozen output ceiling is checked after the response.
Wall time, request count, conservative token reservation and request-size limits constrain
execution; any recorded overshoot fails the trial. Solver duration includes the agent loop,
public verification and per-run setup after credential resolution. Independent final
grading duration is reported separately. Timing alone is not a capability improvement.

An unchanged or worse result is a completed experiment. A scaffold, scripted model run,
missing evidence, or successful unit tests alone is not. This loop is one strategy search
step toward studying self-improvement, and does not establish RSI.
