/** DSH session JSONL transcript storage shared by Spark host implementations. */

export {
  CURRENT_SPARK_SESSION_VERSION,
  type SparkSessionHeader,
  type SparkSessionEntryBase,
  type SparkSessionMessage,
  type SparkSessionMessageEntry,
  type SparkThinkingLevelChangeEntry,
  type SparkModelChangeEntry,
  type SparkCompactionOutcomeMetadata,
  type SparkCompactionEntry,
  type SparkBranchSummaryEntry,
  type SparkCustomEntry,
  type SparkCustomMessageEntry,
  type SparkLabelEntry,
  type SparkSessionInfoEntry,
  type SparkSessionEntry,
  type SparkSessionFileEntry,
  type SparkSessionRecord,
  type SparkSessionInfo,
  type SparkSessionStoreOptions,
  type NewSparkSessionOptions,
  type SparkSessionAtomicWriteOptions,
} from "./types.ts";
export {
  SPARK_DSH_SESSION_FORMAT_VERSION,
  SPARK_DSH_META_EVENT_TYPE,
  SPARK_DSH_RECORD_EVENT_TYPE,
  SPARK_DSH_MESSAGE_META_EVENT_TYPE,
  decodeSparkDshSessionJsonl,
  dshDocumentToSparkRecord,
  isSparkDshV4Document,
} from "./dsh-format.ts";
export {
  SparkSessionStore,
  defaultSparkSessionsRoot,
  defaultSparkHome,
  workspaceSessionHash,
  parseSparkSessionEntries,
  stableSparkSessionContextEntries,
  writeJsonLinesAtomically,
} from "./store.ts";
export { SparkJsonlSessionFiles } from "./jsonl-files.ts";
export { migrateSparkSessionJsonlToDsh } from "./pi-v3-migration.ts";
