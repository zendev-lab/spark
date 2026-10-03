import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSparkReproRoleSpecs,
  registerSparkReproRoles,
  SPARK_REPRO_ROLE_IDS,
} from "../policy/spark-repro-roles.ts";
import { createDefaultRoleRegistry, hydrateExtensionRoles } from "@zendev-lab/spark-roles";

test("Repro extension roles are bounded specialists without ask or spawn authority", () => {
  const roles = createSparkReproRoleSpecs("2026-07-29T00:00:00.000Z");
  assert.deepEqual(
    roles.map((role) => role.id),
    SPARK_REPRO_ROLE_IDS,
  );
  const forbidden = new Set(["ask", "ask_user", "ask_flow", "role", "assign", "task_write"]);
  for (const role of roles) {
    assert.equal(role.source, "extension");
    assert.equal(role.ref, `role:extension-${role.id}`);
    assert.equal(
      role.allowedTools?.some((tool) => forbidden.has(tool)),
      false,
    );
  }
  for (const role of roles) {
    assert.equal(role.allowedTools?.includes("edit"), true);
    assert.equal(role.allowedTools?.includes("write"), true);
    assert.equal(role.allowedTools?.includes("git"), true);
  }
  registerSparkReproRoles();
  const registry = createDefaultRoleRegistry();
  hydrateExtensionRoles(registry);
  for (const role of roles) assert.equal(registry.get(role.ref).id, role.id);
});

test("three Repro lane Roles use checkpoint v2 without Git cwd assumptions", () => {
  const roles = createSparkReproRoleSpecs("2026-08-19T00:00:00.000Z");
  for (const id of [
    "repro-implementation-explorer",
    "repro-exactness-instrumentation-worker",
    "repro-precision-fixer",
  ]) {
    const role = roles.find((candidate) => candidate.id === id);
    assert.ok(role?.systemPrompt);
    assert.match(role.systemPrompt, /spark\.repro\.lane-result\/v2/u);
    assert.match(role.systemPrompt, /zero, one, or many repositories/u);
    assert.match(role.systemPrompt, /never assume|do not assume|instead of assuming/u);
    assert.doesNotMatch(role.systemPrompt, /originRouteId|sourceRevision|bindingRevision/u);
  }
});
