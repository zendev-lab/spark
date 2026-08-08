import { createHash } from "node:crypto";

export const sparkSqliteMigrationPhases = ["expand", "backfill", "contract"] as const;
export type SparkSqliteMigrationPhase = (typeof sparkSqliteMigrationPhases)[number];

export type SparkSqliteMigrationProvenance = "legacy-unverified" | "governed";

export interface SparkSqliteMigrationManifestEntry {
  id: string;
  name: string;
  phase: SparkSqliteMigrationPhase;
  provenance: SparkSqliteMigrationProvenance;
  introducedRelease: string | null;
  checksum: string;
  sqlPath: string | null;
  automatic: boolean;
  transactional: boolean;
  restartable: boolean;
  backupRequired: boolean;
  minimumReadableHead: string;
  minimumWritableHead: string;
  closesMigration: string | null;
}
export interface SparkSqliteMigrationManifest {
  schemaVersion: 2;
  owner: string;
  databaseId: string;
  currentSchemaHead: string;
  minimumReadableHead: string;
  minimumWritableHead: string;
  baseline: {
    id: string;
    kind: "numbered-sql" | "validated-legacy-shape";
    checksum: string;
    checksumKind: "packaged-sql-bytes" | "canonical-schema-descriptor";
    checksumPath: string;
    provenance: SparkSqliteMigrationProvenance;
    introducedRelease: string | null;
    historicalMigrationHistoryAvailable: boolean;
  };
  preGovernanceMigrations: SparkSqliteMigrationManifestEntry[];
  migrations: SparkSqliteMigrationManifestEntry[];
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const releasePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const manifestKeys = [
  "schemaVersion",
  "owner",
  "databaseId",
  "currentSchemaHead",
  "minimumReadableHead",
  "minimumWritableHead",
  "baseline",
  "preGovernanceMigrations",
  "migrations",
] as const;
const baselineKeys = [
  "id",
  "kind",
  "checksum",
  "checksumKind",
  "checksumPath",
  "provenance",
  "introducedRelease",
  "historicalMigrationHistoryAvailable",
] as const;
const entryKeys = [
  "id",
  "name",
  "phase",
  "provenance",
  "introducedRelease",
  "checksum",
  "sqlPath",
  "automatic",
  "transactional",
  "restartable",
  "backupRequired",
  "minimumReadableHead",
  "minimumWritableHead",
  "closesMigration",
] as const;

export class SparkSqliteMigrationManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SparkSqliteMigrationManifestError";
  }
}
export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseSparkSqliteMigrationManifest(input: unknown): SparkSqliteMigrationManifest {
  const manifest = requireRecord(input, "migration manifest");
  requireExactKeys(manifest, manifestKeys, "migration manifest");
  if (manifest.schemaVersion !== 2) {
    fail(
      `migration manifest schemaVersion received ${JSON.stringify(manifest.schemaVersion)}; supported value is 2. Regenerate the owner manifest with schemaVersion 2 before retrying.`,
    );
  }
  const owner = requireString(manifest.owner, "owner");
  const databaseId = requireString(manifest.databaseId, "databaseId");
  const currentSchemaHead = requireString(manifest.currentSchemaHead, "currentSchemaHead");
  const minimumReadableHead = requireString(manifest.minimumReadableHead, "minimumReadableHead");
  const minimumWritableHead = requireString(manifest.minimumWritableHead, "minimumWritableHead");
  const baselineRecord = requireRecord(manifest.baseline, "baseline");
  requireExactKeys(baselineRecord, baselineKeys, "baseline");
  const baselineKind = baselineRecord.kind as "numbered-sql" | "validated-legacy-shape";
  if (baselineKind !== "numbered-sql" && baselineKind !== "validated-legacy-shape")
    fail("baseline.kind must be numbered-sql or validated-legacy-shape");
  const baselineProvenance = requireProvenance(baselineRecord.provenance, "baseline.provenance");
  const checksumKind = baselineRecord.checksumKind as
    | "packaged-sql-bytes"
    | "canonical-schema-descriptor";
  if (checksumKind !== "packaged-sql-bytes" && checksumKind !== "canonical-schema-descriptor")
    fail("baseline.checksumKind must identify packaged SQL bytes or a canonical schema descriptor");
  const baseline = {
    id: requireString(baselineRecord.id, "baseline.id"),
    kind: baselineKind,
    checksum: requireChecksum(baselineRecord.checksum, "baseline.checksum"),
    checksumKind,
    checksumPath: requireString(baselineRecord.checksumPath, "baseline.checksumPath"),
    provenance: baselineProvenance,
    introducedRelease: requireProvenanceRelease(
      baselineProvenance,
      baselineRecord.introducedRelease,
      "baseline.introducedRelease",
    ),
    historicalMigrationHistoryAvailable: requireBoolean(
      baselineRecord.historicalMigrationHistoryAvailable,
      "baseline.historicalMigrationHistoryAvailable",
    ),
  };
  if (baseline.provenance === "legacy-unverified" && baseline.historicalMigrationHistoryAvailable) {
    fail("legacy-unverified baseline cannot claim historical migration history");
  }
  if (
    baseline.kind === "validated-legacy-shape" &&
    baseline.checksumKind !== "canonical-schema-descriptor"
  ) {
    fail("validated-legacy-shape baseline must checksum a canonical schema descriptor");
  }
  if (baseline.kind === "numbered-sql" && baseline.checksumKind !== "packaged-sql-bytes") {
    fail("numbered-sql baseline must checksum packaged SQL bytes");
  }
  if (!Array.isArray(manifest.preGovernanceMigrations))
    fail("preGovernanceMigrations must be an array");
  if (!Array.isArray(manifest.migrations)) fail("migrations must be an array");
  const ids = new Set<string>();
  const parseEntries = (
    values: unknown[],
    provenanceKind: SparkSqliteMigrationProvenance,
    collection: string,
  ) =>
    values.map((value, index) => {
      const label = collection + "[" + index + "]";
      const entry = requireRecord(value, label);
      requireExactKeys(entry, entryKeys, label);
      const id = requireString(entry.id, label + ".id");
      if (ids.has(id)) fail("duplicate migration id: " + id);
      ids.add(id);
      const phase = entry.phase;
      if (!sparkSqliteMigrationPhases.includes(phase as SparkSqliteMigrationPhase))
        fail("invalid migration phase for " + id + ": " + String(phase));
      const provenance = requireProvenance(entry.provenance, id + ".provenance");
      if (provenance !== provenanceKind)
        fail(id + ": " + collection + " must use " + provenanceKind + " provenance");
      const automatic = requireBoolean(entry.automatic, id + ".automatic");
      if (phase !== "expand" && automatic)
        fail(id + ": " + String(phase) + " migration cannot be automatic");
      if (provenance === "legacy-unverified" && automatic)
        fail(id + ": legacy-unverified migration cannot be automatic");
      const sqlPath = entry.sqlPath;
      if (sqlPath !== null && (typeof sqlPath !== "string" || sqlPath.length === 0))
        fail(id + ".sqlPath must be a non-empty string or null");
      return {
        id,
        name: requireString(entry.name, id + ".name"),
        phase: phase as SparkSqliteMigrationPhase,
        provenance,
        introducedRelease: requireProvenanceRelease(
          provenance,
          entry.introducedRelease,
          id + ".introducedRelease",
        ),
        checksum: requireChecksum(entry.checksum, id + ".checksum"),
        sqlPath,
        automatic,
        transactional: requireBoolean(entry.transactional, id + ".transactional"),
        restartable: requireBoolean(entry.restartable, id + ".restartable"),
        backupRequired: requireBoolean(entry.backupRequired, id + ".backupRequired"),
        minimumReadableHead: requireString(entry.minimumReadableHead, id + ".minimumReadableHead"),
        minimumWritableHead: requireString(entry.minimumWritableHead, id + ".minimumWritableHead"),
        closesMigration:
          entry.closesMigration === null
            ? null
            : requireString(entry.closesMigration, id + ".closesMigration"),
      };
    });
  const preGovernanceMigrations = parseEntries(
    manifest.preGovernanceMigrations,
    "legacy-unverified",
    "preGovernanceMigrations",
  );
  const governedMigrations = parseEntries(manifest.migrations, "governed", "migrations");
  const result: SparkSqliteMigrationManifest = {
    schemaVersion: 2,
    owner,
    databaseId,
    currentSchemaHead,
    minimumReadableHead,
    minimumWritableHead,
    baseline,
    preGovernanceMigrations,
    migrations: governedMigrations,
  };
  validateHeadRanges(result);
  validateContracts(result);
  return result;
}

function validateHeadRanges(manifest: SparkSqliteMigrationManifest): void {
  const allMigrations = [...manifest.preGovernanceMigrations, ...manifest.migrations];
  const orderedHeads = [...new Set([manifest.baseline.id, ...allMigrations.map(({ id }) => id)])];
  const index = new Map(orderedHeads.map((head, position) => [head, position]));
  for (const [label, head] of [
    ["currentSchemaHead", manifest.currentSchemaHead],
    ["minimumReadableHead", manifest.minimumReadableHead],
    ["minimumWritableHead", manifest.minimumWritableHead],
  ] as const)
    if (!index.has(head)) fail(label + " references unknown head: " + head);
  if (index.get(manifest.minimumReadableHead)! > index.get(manifest.currentSchemaHead)!)
    fail("minimumReadableHead cannot be newer than currentSchemaHead");
  if (index.get(manifest.minimumWritableHead)! > index.get(manifest.currentSchemaHead)!)
    fail("minimumWritableHead cannot be newer than currentSchemaHead");
  for (const entry of allMigrations) {
    const entryIndex = index.get(entry.id)!;
    const readableIndex = index.get(entry.minimumReadableHead);
    const writableIndex = index.get(entry.minimumWritableHead);
    if (readableIndex === undefined || readableIndex > entryIndex)
      fail(entry.id + ": invalid minimumReadableHead " + entry.minimumReadableHead);
    if (writableIndex === undefined || writableIndex > entryIndex)
      fail(entry.id + ": invalid minimumWritableHead " + entry.minimumWritableHead);
  }
}
function validateContracts(manifest: SparkSqliteMigrationManifest): void {
  const allMigrations = [...manifest.preGovernanceMigrations, ...manifest.migrations];
  const entries = new Map(allMigrations.map((entry) => [entry.id, entry]));
  for (const entry of allMigrations) {
    if (entry.phase !== "contract") {
      if (entry.closesMigration !== null)
        fail(entry.id + ": only contract migrations may close another migration");
      continue;
    }
    if (!entry.closesMigration)
      fail(entry.id + ": contract migration must name the expand migration it closes");
    const expanded = entries.get(entry.closesMigration);
    if (!expanded || expanded.phase !== "expand")
      fail(
        entry.id +
          ": contract migration closes missing or non-expand migration " +
          entry.closesMigration,
      );
    if (
      expanded.provenance !== "governed" ||
      entry.provenance !== "governed" ||
      expanded.introducedRelease === null ||
      entry.introducedRelease === null
    ) {
      fail(entry.id + ": contract timing requires governed migration provenance");
    }
    if (releaseDistance(expanded.introducedRelease, entry.introducedRelease) < 2)
      fail(
        entry.id +
          ": contract migration must be introduced at least two minor releases after " +
          expanded.id,
      );
  }
}
function releaseDistance(from: string, to: string): number {
  const [fromMajor, fromMinor] = from.split(".").map(Number);
  const [toMajor, toMinor] = to.split(".").map(Number);
  return (toMajor! - fromMajor!) * 1000 + toMinor! - fromMinor!;
}
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(label + " must be an object");
  return value as Record<string, unknown>;
}
function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(record))
    if (!expectedSet.has(key)) fail(label + " contains unknown field: " + key);
  for (const key of expected)
    if (!(key in record)) fail(label + " is missing required field: " + key);
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(label + " must be a non-empty string");
  return value;
}
function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(label + " must be boolean");
  return value;
}
function requireChecksum(value: unknown, label: string): string {
  const checksum = requireString(value, label);
  if (!sha256Pattern.test(checksum)) fail(label + " must be a lowercase SHA-256 digest");
  return checksum;
}
function requireProvenance(value: unknown, label: string): SparkSqliteMigrationProvenance {
  if (value !== "legacy-unverified" && value !== "governed")
    fail(label + " must be legacy-unverified or governed");
  return value;
}
function requireProvenanceRelease(
  provenance: SparkSqliteMigrationProvenance,
  value: unknown,
  label: string,
): string | null {
  if (provenance === "legacy-unverified") {
    if (value !== null) fail(label + " must be null for legacy-unverified provenance");
    return null;
  }
  return requireRelease(value, label);
}
function requireRelease(value: unknown, label: string): string {
  const release = requireString(value, label);
  if (!releasePattern.test(release)) fail(label + " must be a stable semver release");
  return release;
}
function fail(message: string): never {
  throw new SparkSqliteMigrationManifestError(message);
}
