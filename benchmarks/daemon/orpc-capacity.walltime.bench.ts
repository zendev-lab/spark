import { test } from "vitest";

import { assertDaemonOrpcCapacityCase, runDaemonOrpcCapacityCase } from "./orpc-capacity-cases.ts";

test("Spark daemon capacity production path", async ({ bench }) => {
  await bench("50 fake-provider AgentLoops with direct oRPC and 2,500 streaming deltas", async () => {
    const report = await runDaemonOrpcCapacityCase();
    assertDaemonOrpcCapacityCase(report);
  }).run({
    iterations: 1,
    time: 0,
    warmupIterations: 0,
    warmupTime: 0,
  });
});
