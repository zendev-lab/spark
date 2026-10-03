import { WorkflowRunStore, sparkWorkflowRunStorePath } from "@zendev-lab/spark-workflows";
import { type SparkStateRootContext } from "@zendev-lab/spark-platform-node/paths";

/** Compatibility shim: workflow-run state is owned by @zendev-lab/spark-workflows. */
export { sparkWorkflowRunStorePath };

export function defaultSparkWorkflowRunStore(
  cwd: string,
  ctx?: SparkStateRootContext,
): WorkflowRunStore {
  return new WorkflowRunStore(sparkWorkflowRunStorePath(cwd, ctx));
}
