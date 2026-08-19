import assert from "node:assert/strict";
import { test } from "vitest";

import { apply } from "./index.ts";

test("spark-web-dsh host half is an inert loader entry", () => {
  assert.equal(typeof apply, "function");
});
