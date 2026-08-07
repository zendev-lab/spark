import {
  defaultTaskGraphStore,
  defaultTaskTodoStore,
  type TaskGraph,
} from "@zendev-lab/spark-tasks";
import {
  currentSessionDirectoryName,
  rebuildSessionIndex,
  sanitizeStoreScope,
  sessionDirectoryPath,
  sessionHiddenRoleRunInboxStorePath,
  sessionIndexStorePath,
  sessionLoopStorePathV2,
  sessionGoalStorePathV2,
  sessionStateStorePath,
  sessionTodoDisplayNumberStorePath,
  sparkSessionKey,
  sparkSessionOwnerKey,
  sparkStateCwd,
  sparkStateRootPath,
  type SparkSessionContext,
  type SparkSessionIndexEntry,
  type SparkSessionIndexSnapshot,
} from "@zendev-lab/spark-loop";

export {
  clearCurrentProjectRef,
  currentSparkProject,
  currentProjectStorePath,
  importLegacyCurrentProjectState,
  loadCurrentProjectRef,
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionMode,
  sparkRunStrategyForMaxConcurrency,
  sparkRunStrategyMaxConcurrency,
  type CurrentProjectStoreSnapshot,
  type SparkAgentMode,
  type SparkPlanningModeSource,
  type SparkRunStrategy,
} from "./current-project-state.ts";
export {
  loadSparkMode,
  nextSparkSessionMode,
  saveSparkMode,
  SPARK_SESSION_MODES,
  type SparkSessionMode,
  type SparkSessionModeInput,
  type SparkSessionModeState,
} from "./session-mode.ts";
export {
  importLegacyHiddenRoleRunInboxState,
  loadHiddenRoleRunInboxState,
  saveHiddenRoleRunInboxState,
  type HiddenRoleRunInboxState,
} from "./hidden-role-run-inbox.ts";
export { importLegacySessionGoal } from "./spark-session-goals.ts";
export { importLegacySessionLoop } from "./spark-session-loops.ts";
export { importLegacyTodoDisplayNumberState } from "./session-todos.ts";
export { writeJsonFileAtomic } from "./json-store.ts";
export {
  currentSessionDirectoryName,
  rebuildSessionIndex,
  sessionDirectoryPath,
  sessionHiddenRoleRunInboxStorePath,
  sessionIndexStorePath,
  sessionLoopStorePathV2,
  sessionGoalStorePathV2,
  sessionStateStorePath,
  sessionTodoDisplayNumberStorePath,
  type SparkSessionIndexEntry,
  type SparkSessionIndexSnapshot,
  sanitizeStoreScope,
  sparkSessionKey,
  sparkSessionOwnerKey,
  sparkStateCwd,
  sparkStateRootPath,
  type SparkSessionContext,
};

export async function loadSparkGraph(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<TaskGraph | null> {
  return defaultTaskGraphStore(sparkStateCwd(cwd, ctx)).load();
}

export async function saveSparkGraphAndTodos(
  cwd: string,
  graph: TaskGraph,
  ctx?: SparkSessionContext,
  store = defaultTaskGraphStore(sparkStateCwd(cwd, ctx)),
): Promise<void> {
  await store.save(graph);
}

export function sparkTodoStore(
  cwd: string,
  ctx?: SparkSessionContext,
): ReturnType<typeof defaultTaskTodoStore> {
  return defaultTaskTodoStore(sparkStateCwd(cwd, ctx), sparkSessionKey(ctx));
}
