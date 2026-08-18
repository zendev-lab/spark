import { test } from "vitest";

import {
  DAEMON_ORPC_CAPACITY_ATTEMPT_TIMEOUT_MS,
  assertDaemonOrpcCapacityCase,
  daemonOrpcCapacityDiagnostics,
  runDaemonOrpcCapacityCase,
} from "../../benchmarks/daemon/orpc-capacity-cases.ts";

test(
  "50 fake-provider AgentLoops complete with responsive direct oRPC",
  async () => {
    const report = await runDaemonOrpcCapacityCase();
    assertDaemonOrpcCapacityCase(report);
    console.log(
      `SPARK_DAEMON_ORPC_CAPACITY ${JSON.stringify(daemonOrpcCapacityDiagnostics(report))}`,
    );
  },
  DAEMON_ORPC_CAPACITY_ATTEMPT_TIMEOUT_MS + 10_000,
);
