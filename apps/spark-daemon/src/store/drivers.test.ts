import { DatabaseSync } from "node:sqlite";
import { runSparkDriverStoreContract } from "./drivers.contract.ts";
import { SparkDriverStore } from "./drivers.ts";
import { SparkInvocationStore } from "./invocations.ts";
import { migrateSparkDaemonDatabase } from "./schema.ts";

runSparkDriverStoreContract(() => {
  const db = new DatabaseSync(":memory:");
  migrateSparkDaemonDatabase(db);
  const invocations = new SparkInvocationStore(db);
  return {
    db,
    invocations,
    drivers: new SparkDriverStore(db, invocations),
    close: () => db.close(),
  };
});
