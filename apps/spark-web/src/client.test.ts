import assert from "node:assert/strict";
import { test } from "vitest";

import plugin, { inject, name } from "./client.tsx";

test("spark-web-dsh client plugin exposes the onboarding registration shape", () => {
  assert.equal(name, "spark-web-dsh");
  assert.deepEqual(inject, ["slots", "locale", "connection", "remote"]);
  assert.equal(typeof plugin.apply, "function");
});
