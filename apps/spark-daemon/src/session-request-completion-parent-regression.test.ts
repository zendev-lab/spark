import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SparkSessionRegistryRecord } from "@zendev-lab/spark-protocol";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { describe, expect, it } from "vitest";

import {
  notifySessionRequestCompletion,
  renderSessionRequestCompletionPrompt,
  SESSION_REQUEST_COMPLETION_SOURCE_KIND,
} from "./session-request-completion-notify.ts";
import { SparkInvocationStore } from "./store/invocations.ts";
import { migrateSparkDaemonDatabase } from "./store/schema.ts";

describe("parent production completion recovery regression", () => {
  it("persists accepted terminal completion mail before sender availability across restart", async () => {
    const harness = createHarness();
    const firstStore = new SparkInvocationStore(harness.db);
    const sender = localSession("sess_sender", harness.cwd);
    const target = localSession("sess_target", harness.cwd);
    const source = firstStore.submit({
      sessionId: target.sessionId,
      prompt: "do delegated work",
      task: requestMailTask(sender.sessionId, target.sessionId, true),
    });
    expect(firstStore.claimNext("target-worker")?.invocationId).toBe(source.invocationId);
    firstStore.complete(source.invocationId, {
      status: "succeeded",
      result: { assistantText: "delegated result" },
    });

    harness.db.close();
    const restartedDb = new DatabaseSync(harness.dbPath);
    migrateSparkDaemonDatabase(restartedDb);
    const restartedStore = new SparkInvocationStore(restartedDb);

    try {
      expect(restartedStore.require(source.invocationId).status).toBe("succeeded");
      await notifySessionRequestCompletion(
        {
          invocationStore: restartedStore,
          mailStore: new SparkSessionMailStore({ sparkHome: harness.cwd }),
          sessionRegistry: {
            get: async () => undefined,
            recordTurnQueued: async () => sender,
          },
        },
        {
          invocation: restartedStore.require(source.invocationId),
          task: source.task as never,
          completion: { status: "succeeded", result: { assistantText: "delegated result" } },
        },
      );
      const completionMailCount = (
        await new SparkSessionMailStore({ sparkHome: harness.cwd }).list(sender.sessionId, {
          includeAcked: true,
        })
      ).filter((mail) => mail.correlationId === source.invocationId).length;
      const senderWakeCount = restartedStore.listPendingForSession(sender.sessionId).length;
      expect(completionMailCount).toBe(1);
      expect(senderWakeCount).toBe(1);
    } finally {
      restartedDb.close();
      harness.close();
    }
  });
});

function createHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "spark-session-request-completion-"));
  const dbPath = join(cwd, "daemon.sqlite");
  const db = new DatabaseSync(dbPath);
  migrateSparkDaemonDatabase(db);
  return {
    cwd,
    db,
    dbPath,
    close() {
      if (db.isOpen) db.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

function localSession(sessionId: string, cwd: string): SparkSessionRegistryRecord {
  return {
    sessionId,
    scope: { kind: "workspace", workspaceId: "workspace-test" },
    workspaceId: "workspace-test",
    cwd,
    status: "ready",
    bindings: [],
    createdAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function requestMailTask(fromSessionId: string, toSessionId: string, notifyOnCompletion: boolean) {
  return {
    type: "session.run" as const,
    sessionId: toSessionId,
    prompt: "delegated work",
    messageMetadata: {
      sessionMail: {
        messageId: "mail:admission",
        kind: "request",
        fromSessionId,
        toSessionId,
        notifyOnCompletion,
      },
    },
  };
}
