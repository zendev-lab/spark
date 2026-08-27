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

test("startup access token revocation retries transient daemon failures", async () => {
  let attempts = 0;
  const access = await createSparkWebStartupAccessToken("spark web", {
    create: async () => ({ token: "sdu_token", record: { id: "dut_web" } }),
    revoke: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("daemon restarting");
    },
    revokeRetryDelaysMs: [0],
  });

  await access.revoke();
  assert.equal(attempts, 2);
});

test("a failed startup token revocation can be attempted again", async () => {
  let attempts = 0;
  const access = await createSparkWebStartupAccessToken("spark web", {
    create: async () => ({ token: "sdu_token", record: { id: "dut_web" } }),
    revoke: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("daemon unavailable");
    },
    revokeRetryDelaysMs: [],
  });

  await assert.rejects(() => access.revoke(), /daemon unavailable/u);
  await access.revoke();
  assert.equal(attempts, 2);
});
