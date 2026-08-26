import assert from "node:assert/strict";
import { test } from "vitest";

import { npmDistributionById } from "../scripts/npm-distributions.mjs";

test("published web-dsh keeps the host and client plugin exports", () => {
  const webDsh = npmDistributionById.get("web-dsh");
  assert.ok(webDsh !== undefined);
  assert.deepEqual(webDsh.exports, {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./executable": "./bin/spark-web-dsh",
    "./package.json": "./package.json",
  });
  assert.deepEqual(webDsh.dsh, {
    client: {
      platform: "web",
      inject: ["slots", "locale", "connection", "remote"],
    },
  });
});
