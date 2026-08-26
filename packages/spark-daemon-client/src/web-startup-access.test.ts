import assert from "node:assert/strict";
import { test } from "vitest";

import { createSparkWebStartupAccessToken } from "./web-startup-access.ts";

test("startup access tokens are daemon-created and revoked once", async () => {
  const creates: Array<{ label: string }> = [];
  const revokes: Array<{ id: string }> = [];
  const access = await createSparkWebStartupAccessToken(" spark web ", {
    create: async (input) => {
      creates.push(input);
      return { token: "sdu_abcdefghijklmnopqrstuvwxyz123456", record: { id: "dut_web" } };
    },
    revoke: async (input) => {
      revokes.push(input);
      return { id: input.id, revoked: true };
    },
  });

  assert.deepEqual(creates, [{ label: "spark web" }]);
  assert.equal(access.token, "sdu_abcdefghijklmnopqrstuvwxyz123456");
  assert.equal(access.recordId, "dut_web");
  await Promise.all([access.revoke(), access.revoke()]);
  assert.deepEqual(revokes, [{ id: "dut_web" }]);
});

test("startup access tokens reject empty owner labels before daemon mutation", async () => {
  await assert.rejects(() => createSparkWebStartupAccessToken("  "), /requires a label/u);
});
