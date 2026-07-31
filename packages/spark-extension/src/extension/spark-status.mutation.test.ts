import assert from "node:assert/strict";
import { test } from "vitest";
import {
  normalizeSparkStatusFormat,
  normalizeSparkStatusLimit,
  normalizeSparkStatusScope,
  normalizeSparkStatusView,
  shouldRenderProjectInSparkStatus,
} from "./spark-status.ts";

test("status parser defaults and accepts every declared enum value", () => {
  assert.equal(normalizeSparkStatusScope({}), "workspace");
  assert.equal(normalizeSparkStatusScope({ scope: "project" }), "project");
  assert.equal(normalizeSparkStatusScope({ scope: "task" }), "task");
  assert.equal(normalizeSparkStatusView({}), "active");
  assert.equal(normalizeSparkStatusView({ view: "summary" }), "summary");
  assert.equal(normalizeSparkStatusFormat({}), "text");
  assert.equal(normalizeSparkStatusFormat({ format: "json" }), "json");
});

test("status parser rejects values outside its public enums", () => {
  assert.throws(() => normalizeSparkStatusScope({ scope: "run" }), /workspace, project, or task/);
  assert.throws(() => normalizeSparkStatusView({ view: "all" }), /active or summary/);
  assert.throws(() => normalizeSparkStatusFormat({ format: "yaml" }), /text or json/);
});

test("status limit accepts zero and positive integers", () => {
  assert.equal(normalizeSparkStatusLimit({}), undefined);
  assert.equal(normalizeSparkStatusLimit({ limit: 0 }), 0);
  assert.equal(normalizeSparkStatusLimit({ limit: 7 }), 7);
});

test("status limit rejects non-finite, fractional, and negative numbers", () => {
  assert.throws(() => normalizeSparkStatusLimit({ limit: Number.NaN }), /finite number/);
  assert.throws(() => normalizeSparkStatusLimit({ limit: 1.5 }), /non-negative integer/);
  assert.throws(() => normalizeSparkStatusLimit({ limit: -1 }), /non-negative integer/);
});

test("active project visibility is limited to the active or session-claimed project", () => {
  const projectRef = "proj:one" as const;
  assert.equal(
    shouldRenderProjectInSparkStatus({ view: "summary", projectRef, sessionClaimedCount: 0 }),
    true,
  );
  assert.equal(
    shouldRenderProjectInSparkStatus({
      view: "active",
      projectRef,
      activeProjectRef: projectRef,
      sessionClaimedCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldRenderProjectInSparkStatus({ view: "active", projectRef, sessionClaimedCount: 1 }),
    true,
  );
  assert.equal(
    shouldRenderProjectInSparkStatus({ view: "active", projectRef, sessionClaimedCount: 0 }),
    false,
  );
});
