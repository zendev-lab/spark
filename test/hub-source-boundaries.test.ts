import assert from "node:assert/strict";
import { test } from "vitest";

import { hubSourceBoundaryViolations } from "../scripts/check-hub-source-boundaries.mjs";

test("Hub source policy rejects direct state-owner access", () => {
  assert.deepEqual(
    hubSourceBoundaryViolations(
      "apps/spark-hub/src/routes/[workspaceId]/+page.server.ts",
      `
        import { db } from "@zendev-lab/spark-hub-db";
        import { registry } from "@zendev-lab/spark-session";
        import { daemon } from "@zendev-lab/spark-daemon/runtime";
        db.prepare("select 1");
        const path = ".spark/artifacts";
      `,
    ),
    [
      "page load opens SQL directly",
      "Hub presentation imports spark-hub-db directly",
      "Hub source imports daemon internals",
      "Hub source bypasses protocol artifact access",
      "Hub source bypasses daemon-owned session mutations",
    ],
  );
});

test("Hub source policy allows owner API imports", () => {
  assert.deepEqual(
    hubSourceBoundaryViolations(
      "apps/spark-hub/src/routes/[workspaceId]/+page.server.ts",
      'import { loadPage } from "@zendev-lab/spark-hub-coordination/hub-queries";\n',
    ),
    [],
  );
});
