import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SparkInvocationStore } from "../store/invocations.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { invocationListResult, invocationResult } from "./helpers.ts";

describe("daemon local RPC invocation payload boundaries", () => {
  it("keeps list/status payload-free and reads terminal result only for turn.result", () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const store = new SparkInvocationStore(db);
    try {
      const invocation = store.submit({
        sessionId: "session-explicit-result",
        prompt: "result",
        task: { type: "session.run", sessionId: "session-explicit-result", prompt: "result" },
      });
      expect(store.claimNext("worker")?.invocationId).toBe(invocation.invocationId);
      store.complete(invocation.invocationId, {
        status: "succeeded",
        result: { assistantText: "a".repeat(300_000) },
      });

      expect(invocationListResult(store, { limit: 20, offset: 0 }).invocations).toHaveLength(1);
      expect(store.getSummary(invocation.invocationId)).toMatchObject({ status: "succeeded" });
      expect(invocationResult(store, invocation.invocationId).assistantText).toHaveLength(262_144);

      db.prepare("UPDATE invocations SET result_json = ? WHERE id = ?").run(
        "{invalid terminal result",
        invocation.invocationId,
      );
      expect(() => invocationListResult(store, { limit: 20, offset: 0 })).not.toThrow();
      expect(store.getSummary(invocation.invocationId)).toMatchObject({ status: "succeeded" });
      expect(() => invocationResult(store, invocation.invocationId)).toThrow(
        /Invalid persisted JSON/u,
      );
    } finally {
      db.close();
    }
  });
});
