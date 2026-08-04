export const capabilitySentinelTestFiles = Object.freeze([
  "src/spark-tools-capability-sentinel.test.ts",
  "src/spark-tools-repro-lifecycle.test.ts",
  "src/store/loop-cycle-review.test.ts",
  "src/spark/loop-goal-settlements.test.ts",
  "src/spark/repro-loop-evaluator.test.ts",
]);

export function capabilitySentinelCommand(vitestOptions = []) {
  return [
    "--filter",
    "@zendev-lab/spark-daemon",
    "exec",
    "vp",
    "test",
    "run",
    ...vitestOptions,
    ...capabilitySentinelTestFiles,
  ];
}
