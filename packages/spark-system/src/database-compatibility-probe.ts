import { isAbsolute } from "node:path";

export const sparkDatabaseCompatibilityProbeActions = [
  "write-read",
  "create-write",
  "read-write",
  "inspect",
  "interrupt",
  "inject-unsafe",
] as const;

export type SparkDatabaseCompatibilityProbeAction =
  | "write-read"
  | "inspect"
  | "interrupt"
  | "inject-unsafe";
export type SparkDatabaseCompatibilityUnsafeKind = "future" | "dirty" | "checksum";

export interface SparkDatabaseCompatibilityProbeArguments {
  action: SparkDatabaseCompatibilityProbeAction;
  databasePath: string;
  json: true;
  value?: string;
  boundary?: "before-commit";
  migrationId?: string;
  unsafeKind?: SparkDatabaseCompatibilityUnsafeKind;
}

export interface SparkDatabaseCompatibilityLedgerEntry {
  id: string;
  state: "legacy-unverified" | "dirty" | "clean" | "failed";
  checksum: string | null;
  phase?: "expand" | "backfill" | "contract";
}

export interface SparkDatabaseCompatibilityProbeResult {
  schemaVersion: 1;
  owner: "daemon" | "hub";
  action: "write-read" | "inspect";
  database: string;
  head: string;
  manifestSha256: string;
  baselineChecksum: string;
  ledger: SparkDatabaseCompatibilityLedgerEntry[];
  previousValues: string[];
  sentinel?: string;
}

export function parseSparkDatabaseCompatibilityProbeArguments(
  argv: readonly string[],
): SparkDatabaseCompatibilityProbeArguments {
  const [rawAction, ...rest] = argv;
  if (!sparkDatabaseCompatibilityProbeActions.includes(rawAction as never)) {
    throw new Error(
      "Database compatibility probe action must be write-read|create-write|read-write|inspect|interrupt|inject-unsafe",
    );
  }
  const action: SparkDatabaseCompatibilityProbeAction =
    rawAction === "create-write" || rawAction === "read-write"
      ? "write-read"
      : (rawAction as SparkDatabaseCompatibilityProbeAction);
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (token === "--json") {
      if (json) throw new Error("Duplicate --json flag");
      json = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    if (!["--database", "--value", "--boundary", "--migration", "--kind"].includes(token)) {
      throw new Error(`Unknown database compatibility probe option: ${token}`);
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value`);
    if (values.has(token)) {
      throw new Error(`Duplicate database compatibility probe option: ${token}`);
    }
    values.set(token, value);
    index += 1;
  }
  if (!json) throw new Error("Database compatibility probe requires --json");
  const databasePath = values.get("--database");
  if (!databasePath) throw new Error("Database compatibility probe requires --database <absolute>");
  if (!isAbsolute(databasePath)) {
    throw new Error("Database compatibility probe --database must be absolute");
  }
  const value = values.get("--value");
  const boundary = values.get("--boundary");
  const migrationId = values.get("--migration");
  const unsafeKind = values.get("--kind");
  if (action === "interrupt" && boundary !== "before-commit") {
    throw new Error("interrupt requires --boundary before-commit");
  }
  if (
    action === "inject-unsafe" &&
    unsafeKind !== "future" &&
    unsafeKind !== "dirty" &&
    unsafeKind !== "checksum"
  ) {
    throw new Error("inject-unsafe requires --kind future|dirty|checksum");
  }
  const allowed = new Set(
    action === "write-read"
      ? ["--database", "--value"]
      : action === "interrupt"
        ? ["--database", "--boundary", "--migration"]
        : action === "inject-unsafe"
          ? ["--database", "--kind"]
          : ["--database"],
  );
  const unexpected = [...values.keys()].find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`${unexpected} is not valid for ${action}`);
  return {
    action,
    databasePath,
    json: true,
    ...(value ? { value } : {}),
    ...(boundary === "before-commit" ? { boundary } : {}),
    ...(migrationId ? { migrationId } : {}),
    ...(unsafeKind === "future" || unsafeKind === "dirty" || unsafeKind === "checksum"
      ? { unsafeKind }
      : {}),
  };
}
