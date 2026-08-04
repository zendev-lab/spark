import { DatabaseSync } from "node:sqlite";
import { runSparkLoopStoreContract } from "./loops.contract.ts";
import { SparkLoopStore } from "./loops.ts";
import { SparkInvocationStore } from "./invocations.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

runSparkLoopStoreContract(() => {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  return {
    db,
    invocations,
    loops: new SparkLoopStore(db, invocations),
    close: () => db.close(),
  };
});
