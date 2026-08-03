export {
  createEditToolConfig,
  createLsToolConfig,
  createReadToolConfig,
  createWriteToolConfig,
} from "./file-tools.ts";
export { createFindToolConfig, createGrepToolConfig } from "./search-tools.ts";
export {
  default,
  registerSparkFilesTools,
  type SparkFilesHostApi,
  type SparkFilesOptions,
} from "./extension.ts";
export { registerDaemonSparkFilesTools } from "./daemon-extension.ts";
export {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateDiffString,
  generateUnifiedPatch,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type FileEdit,
  type LineEnding,
} from "./edit-diff.ts";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  GREP_MAX_LINE_LENGTH,
  formatSize,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "./truncate.ts";
export { pathExists, resolveReadPath, resolveReadPathSync, resolveToCwd } from "./path-utils.ts";
export { resolveArtifactFileRoot } from "./artifact-root.ts";
export { walkTree, type WalkEntry, type WalkOptions } from "./gitignore-walker.ts";
export {
  atomicReplaceTextFile,
  atomicReplaceTextFiles,
  contentVersion,
  createFileReadMetadata,
  isFileVersionPrecondition,
  MISSING_FILE_VERSION,
  readRegularFileSnapshot,
  type AtomicReplaceConflict,
  type AtomicReplaceResult,
  type AtomicTextFileBatchConflict,
  type AtomicTextFileBatchResult,
  type AtomicTextFileBatchUpdate,
  type FileContentVersion,
  type FileLineAnchor,
  type FileLineEnding,
  type FileReadMetadata,
  type FileReadWindow,
  type FileVersionState,
  type RegularFileSnapshot,
} from "./file-version.ts";
export type { ToolExecResult, ToolTextContent } from "./shared.ts";
