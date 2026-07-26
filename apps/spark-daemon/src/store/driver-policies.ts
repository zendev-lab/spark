import type { SparkDriverPolicyDefinition, SparkRuntimeDriverKind } from "@zendev-lab/spark-core";
import { sparkGoalDriverPolicy, sparkLoopDriverPolicy } from "@zendev-lab/spark-loop";
import { sparkReproDriverPolicy } from "@zendev-lab/spark-repro";
import { sparkWorkflowDriverPolicy } from "@zendev-lab/spark-workflows";

const policies = new Map<SparkRuntimeDriverKind, SparkDriverPolicyDefinition>(
  [
    sparkGoalDriverPolicy,
    sparkLoopDriverPolicy,
    sparkReproDriverPolicy,
    sparkWorkflowDriverPolicy,
  ].map((policy) => [policy.kind, policy]),
);

export function sparkDriverPolicy(kind: SparkRuntimeDriverKind): SparkDriverPolicyDefinition {
  const policy = policies.get(kind);
  if (!policy) throw new Error(`DRIVER_POLICY_MISSING: ${kind}`);
  return policy;
}
