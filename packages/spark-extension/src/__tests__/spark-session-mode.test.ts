import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";

import type { ProjectRef } from "@zendev-lab/spark-core";
import {
  currentProjectStorePath,
  loadCurrentProjectState,
  loadSparkMode,
  nextSparkSessionMode,
  saveSparkMode,
  SPARK_SESSION_MODES,
} from "../extension/session-state.ts";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "spark-session-phase-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("loadSparkMode defaults to plan with no persisted state", async () => {
  await withTempDir(async (dir) => {
    const state = await loadSparkMode(dir, undefined);
    assert.deepEqual(state, { mode: "plan" });
  });
});

test("loadSparkMode returns persisted mode and ignores ephemeral host context", async () => {
  await withTempDir(async (dir) => {
    await saveSparkMode(dir, undefined, { mode: "plan" });
    const overrideContext = { sparkActiveMode: { mode: "execute" } } as unknown as NonNullable<
      Parameters<typeof loadSparkMode>[1]
    >;

    assert.deepEqual(await loadSparkMode(dir, overrideContext), { mode: "plan" });
    await saveSparkMode(dir, undefined, { mode: "execute" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "execute" });
  });
});

test("saveSparkMode persists the current session mode and optional project ref", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-research" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "execute", projectRef });

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "execute" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 3,
      projectRef,
      mode: "execute",
    });
  });
});

test("v1 executionMode and planningMode blocks migrate to v3", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-legacy" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "execute", projectRef });
    const statePath = currentProjectStorePath(dir, undefined);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          projectRef,
          phase: "implement",
          planningMode: { invalid: true },
          executionMode: { invalid: true },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "execute" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 3,
      projectRef,
      mode: "execute",
    });
    assert.doesNotMatch(await readFile(statePath, "utf8"), /executionMode/);
  });
});

test("saveSparkMode without projectRef preserves existing current project selection", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear-empty" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "execute", projectRef });
    await saveSparkMode(dir, undefined, { mode: "plan" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "plan" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 3,
      projectRef,
      mode: "plan",
    });
  });
});

test("legacy persisted research phase normalizes one-way to plan", async () => {
  await withTempDir(async (dir) => {
    const legacyStatePath = join(dir, ".spark", "sessions", "session-ephemeral.json");
    const statePath = currentProjectStorePath(dir, undefined);
    await mkdir(dirname(legacyStatePath), { recursive: true });
    await writeFile(legacyStatePath, '{"version":1,"phase":"research"}\n', "utf8");

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "plan" });
    await saveSparkMode(dir, undefined, { mode: "plan" });
    assert.doesNotMatch(await readFile(statePath, "utf8"), /"phase": "research"/u);
    assert.doesNotMatch(await readFile(legacyStatePath, "utf8"), /"phase": "research"/u);
  });
});

test("v2 plan and execute modes migrate to v3 while fleet persists natively", async () => {
  await withTempDir(async (dir) => {
    const statePath = currentProjectStorePath(dir, undefined);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, '{"version":2,"mode":"execute"}\n', "utf8");

    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 3,
      mode: "execute",
    });
    assert.match(await readFile(statePath, "utf8"), /"version": 3/u);

    await saveSparkMode(dir, undefined, { mode: "fleet" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "fleet" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 3,
      mode: "fleet",
    });
  });
});

test("unknown session-state versions fail closed", async () => {
  await withTempDir(async (dir) => {
    const statePath = currentProjectStorePath(dir, undefined);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, '{"version":4,"mode":"fleet"}\n', "utf8");
    await assert.rejects(loadCurrentProjectState(dir, undefined), /version must be 1, 2, or 3/u);
  });
});

test("nextSparkSessionMode walks the canonical cycle", () => {
  assert.deepEqual(SPARK_SESSION_MODES, ["plan", "execute", "fleet"]);
  assert.equal(nextSparkSessionMode("plan"), "execute");
  assert.equal(nextSparkSessionMode("execute"), "fleet");
  assert.equal(nextSparkSessionMode("fleet"), "plan");
});
