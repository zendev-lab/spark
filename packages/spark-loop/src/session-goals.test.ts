import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadSessionGoal, sessionGoalStorePath, setSessionGoal } from "./session-goals.ts";

const ctx = { sessionId: "goal-authority-compat" };

interface StoredGoalSnapshot {
  version: 1;
  goal: {
    contract: {
      authority: Record<string, unknown>;
    };
  };
}

describe("session Goal authority compatibility", () => {
  it("backfills driver authority when a legacy snapshot omits boundedExternalWrites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-goal-authority-legacy-"));
    try {
      const path = await writeGoalSnapshot(dir);
      const snapshot = await readGoalSnapshot(path);
      delete snapshot.goal.contract.authority.boundedExternalWrites;
      await writeFile(path, JSON.stringify(snapshot), "utf8");

      await expect(loadSessionGoal(dir, ctx)).resolves.toMatchObject({
        contract: {
          authority: {
            safeLocal: "auto",
            boundedExternalWrites: "driver",
            externalWrites: "ask",
            destructiveActions: "ask",
            scopeExpansion: "ask",
          },
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed bounded external-write authority fail closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-goal-authority-invalid-"));
    try {
      const path = await writeGoalSnapshot(dir);
      const snapshot = await readGoalSnapshot(path);
      snapshot.goal.contract.authority.boundedExternalWrites = "auto";
      await writeFile(path, JSON.stringify(snapshot), "utf8");

      await expect(loadSessionGoal(dir, ctx)).rejects.toThrow(
        /goal\.contract\.authority is invalid/u,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function writeGoalSnapshot(dir: string): Promise<string> {
  await setSessionGoal(dir, ctx, {
    objective: "Ship a bounded Draft PR",
    source: "explicit",
  });
  return sessionGoalStorePath(dir, ctx);
}

async function readGoalSnapshot(path: string): Promise<StoredGoalSnapshot> {
  return JSON.parse(await readFile(path, "utf8")) as StoredGoalSnapshot;
}
