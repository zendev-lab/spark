import { DatabaseSync } from "node:sqlite";

export function withScriptedProviderLedgerLock<T>(
  ledgerPath: string,
  operation: () => T,
  options: { timeoutMs?: number } = {},
): T {
  // SQLite owns the cross-process lock and releases it even after SIGKILL. Keep
  // this sidecar until fixture teardown: unlinking it would create a second lock.
  // The JSON ledger remains the only data store; this transaction writes no data.
  const lock = new DatabaseSync(`${ledgerPath}.lock.sqlite`, {
    timeout: options.timeoutMs ?? 10_000,
  });
  try {
    lock.exec("BEGIN IMMEDIATE");
    return operation();
  } finally {
    lock.close();
  }
}
