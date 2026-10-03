import { bench, describe } from "vitest";

import { assertDaemonOrpcCapacityCase, runDaemonOrpcCapacityCase } from "./orpc-capacity-cases.ts";

describe("Spark daemon capacity production path", () => {
  bench(
    "50 fake-provider AgentLoops with direct oRPC and 2,500 streaming deltas",
    async () => {
      const report = await runDaemonOrpcCapacityCase();
      assertDaemonOrpcCapacityCase(report);
    },
    {
      iterations: 1,
      time: 0,
      warmupIterations: 0,
      warmupTime: 0,
    },
  );
});
