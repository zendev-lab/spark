import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import type { ProjectRef } from "@zendev-lab/spark-core";
import {
  clearSparkPhase,
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

test("loadSparkMode exposes current host active lens without changing persisted phase", async () => {
  await withTempDir(async (dir) => {
    await saveSparkMode(dir, undefined, { mode: "plan" });
    const state = await loadSparkMode(dir, { sparkActiveMode: { mode: "execute" } });

    assert.deepEqual(state, { mode: "execute" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "plan" });
  });
});

test("loadSparkMode normalizes a legacy research active lens to plan", async () => {
  await withTempDir(async (dir) => {
    await saveSparkMode(dir, undefined, { mode: "execute" });
    const legacyContext = { sparkActiveMode: { mode: "research" } } as unknown as NonNullable<
      Parameters<typeof loadSparkMode>[1]
    >;

    assert.deepEqual(await loadSparkMode(dir, legacyContext), { mode: "plan" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "execute" });
  });
});

test("saveSparkMode persists the current session phase and optional project ref", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-research" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "execute", projectRef, focus: "ship" });

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "execute", projectRef });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 1,
      projectRef,
      mode: "execute",
    });
  });
});

test("legacy executionMode and planningMode blocks are ignored by loadSparkMode", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-legacy" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "execute", projectRef });
    const statePath = join(dir, ".spark", "sessions", "session-ephemeral.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          projectRef,
          mode: "execute",
          planningMode: { invalid: true },
          executionMode: { invalid: true },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "execute", projectRef });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), {
      version: 1,
      projectRef,
      mode: "execute",
    });
    assert.match(await readFile(statePath, "utf8"), /executionMode/);
  });
});

test("clearSparkPhase removes current project selection but preserves session phase", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "plan", projectRef });
    await clearSparkPhase(dir, undefined);
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "plan" });
    assert.deepEqual(await loadCurrentProjectState(dir, undefined), { version: 1, mode: "plan" });
  });
});

test("saveSparkMode without projectRef preserves existing current project selection", async () => {
  await withTempDir(async (dir) => {
    const projectRef = "proj:test-clear-empty" as ProjectRef;
    await saveSparkMode(dir, undefined, { mode: "execute", projectRef });
    await saveSparkMode(dir, undefined, { mode: "plan" });
    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "plan", projectRef });
  });
});

test("legacy persisted research phase normalizes one-way to plan", async () => {
  await withTempDir(async (dir) => {
    const statePath = join(dir, ".spark", "sessions", "session-ephemeral.json");
    await mkdir(join(dir, ".spark", "sessions"), { recursive: true });
    await writeFile(statePath, '{"version":1,"phase":"research"}\n', "utf8");

    assert.deepEqual(await loadSparkMode(dir, undefined), { mode: "plan" });
    await saveSparkMode(dir, undefined, { mode: "plan" });
    assert.doesNotMatch(await readFile(statePath, "utf8"), /"phase": "research"/u);
  });
});

test("nextSparkSessionMode walks the canonical cycle", () => {
  assert.deepEqual(SPARK_SESSION_MODES, ["plan", "execute"]);
  assert.equal(nextSparkSessionMode("plan"), "execute");
  assert.equal(nextSparkSessionMode("execute"), "plan");
});
