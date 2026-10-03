import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type SparkApp = "hub" | "daemon";

export interface ResolveSparkHomeOptions {
  sparkHome?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  cwd?: string | undefined;
}

export interface SparkUserPaths {
  /** Effective Spark config root, normally `$XDG_CONFIG_HOME/spark`. */
  configRoot: string;
  /** Effective Spark persistent data root, normally `$XDG_DATA_HOME/spark`. */
  dataRoot: string;
  /** Effective Spark cache root, normally `$XDG_CACHE_HOME/spark`. */
  cacheRoot: string;
  /** Effective Spark state root, normally `$XDG_STATE_HOME/spark`. */
  stateRoot: string;
  /** Effective Spark runtime root, normally `$XDG_RUNTIME_DIR/spark`. */
  runtimeRoot: string;
  /** Compatibility display root: the explicit SPARK_HOME or the default data root. */
  root: string;
  configFile: string;
  authFile: string;
  sessionsDir: string;
  askConfigFile: string;
  rolesDir: string;
  roleModelSettingsFile: string;
  workflowsDir: string;
  userAgentsSkillsDir: string;
  promptTemplatesDir: string;
  themesDir: string;
  /** User memory tree root: `$dataRoot/memory`. */
  memoryDir: string;
  /** User learnings under the memory tree: `$dataRoot/memory/learnings`. */
  learningsDir: string;
  /** User recall candidates: `$dataRoot/memory/recall-candidates.json`. */
  recallFile: string;
  memoryFile: string;
  agentDir: string;
  keybindingsFile: string;
  exportsDir: string;
  shareDir: string;
  workspacesDir: string;
  cueVersionCacheFile: string;
}

export interface SparkPathOverrides {
  configFile?: string;
  dataDir?: string;
  cacheDir?: string;
  stateDir?: string;
  runtimeDir?: string;
}

export interface SparkStateRootContext {
  sparkStateRoot?: string;
}

/** Resolve the durable workspace-owned Spark state directory for a host context. */
export function sparkStateRootPath(cwd: string, ctx?: SparkStateRootContext): string {
  return ctx?.sparkStateRoot?.trim() || join(cwd, ".spark");
}

/** Resolve a path under the workspace Spark state root, honoring `sparkStateRoot`. */
export function sparkWorkspaceStatePath(
  cwd: string,
  segments: readonly string[],
  ctx?: SparkStateRootContext,
): string {
  return join(sparkStateRootPath(cwd, ctx), ...segments);
}

/** Convert the explicit `.spark` state root back to the owning workspace directory. */
export function sparkStateCwd(cwd: string, ctx?: SparkStateRootContext): string {
  const root = sparkStateRootPath(cwd, ctx);
  return basename(root) === ".spark" ? dirname(root) : cwd;
}

export interface ResolveSparkPathsOptions extends ResolveSparkHomeOptions {
  app: SparkApp;
  overrides?: SparkPathOverrides;
}

export interface SparkPaths<App extends SparkApp = SparkApp> {
  app: App;
  configDir: string;
  configFile: string;
  dataDir: string;
  cacheDir: string;
  stateDir: string;
  runtimeDir: string;
  databasePath: string;
  artifactCacheDir: string;
  artifactBlobsDir: string;
  /** Daemon session runtime directory. On disk this remains `<dataDir>/pi-agent`. */
  sessionRuntimeDir: string | undefined;
  logDir: string;
  logFile: string;
  pidFile: string;
}

const appDatabaseNames: Record<SparkApp, string> = {
  hub: "hub.sqlite",
  daemon: "daemon.sqlite",
};

/**
 * Resolve the explicit Spark root when SPARK_HOME is set.
 *
 * With no SPARK_HOME, this returns the XDG data root so compatibility callers
 * that require one persistent root remain deterministic. New code should use
 * resolveSparkUserPaths() and select the ownership-specific root.
 */
export function resolveSparkHome(options: ResolveSparkHomeOptions = {}): string {
  return resolveSparkUserPaths(options).dataRoot;
}

/** Resolve Spark-owned paths from SPARK_HOME or the standard XDG directories. */
export function resolveSparkUserPaths(options: ResolveSparkHomeOptions = {}): SparkUserPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = nonEmpty(env.HOME) ?? homedir();
  const explicitRoot = nonEmpty(options.sparkHome) ?? nonEmpty(env.SPARK_HOME);
  const sparkRoot = explicitRoot ? absolutePath(explicitRoot, cwd) : undefined;
  const configRoot = sparkRoot ?? join(xdgRoot(env.XDG_CONFIG_HOME, home, ".config", cwd), "spark");
  const dataRoot =
    sparkRoot ?? join(xdgRoot(env.XDG_DATA_HOME, home, ".local/share", cwd), "spark");
  const cacheRoot = sparkRoot ?? join(xdgRoot(env.XDG_CACHE_HOME, home, ".cache", cwd), "spark");
  const stateRoot =
    sparkRoot ?? join(xdgRoot(env.XDG_STATE_HOME, home, ".local/state", cwd), "spark");
  const runtimeRoot = sparkRoot
    ? sparkRoot
    : nonEmpty(env.XDG_RUNTIME_DIR)
      ? join(absolutePath(nonEmpty(env.XDG_RUNTIME_DIR)!, cwd), "spark")
      : stateRoot;
  const root = sparkRoot ?? dataRoot;
  const agentDir = join(configRoot, "agent");

  return {
    configRoot,
    dataRoot,
    cacheRoot,
    stateRoot,
    runtimeRoot,
    root,
    configFile: join(configRoot, "config.json"),
    authFile: join(configRoot, "auth.json"),
    sessionsDir: join(dataRoot, "sessions"),
    askConfigFile: join(configRoot, "ask.json"),
    rolesDir: join(home, ".agents", "roles"),
    roleModelSettingsFile: join(configRoot, "role-model-settings.json"),
    workflowsDir: join(home, ".agents", "workflows"),
    userAgentsSkillsDir: join(home, ".agents", "skills"),
    promptTemplatesDir: join(configRoot, "prompts"),
    themesDir: join(configRoot, "themes"),
    memoryDir: join(dataRoot, "memory"),
    learningsDir: join(dataRoot, "memory", "learnings"),
    recallFile: join(dataRoot, "memory", "recall-candidates.json"),
    memoryFile: join(dataRoot, "memory", "memory.json"),
    agentDir,
    keybindingsFile: join(agentDir, "keybindings.json"),
    exportsDir: join(dataRoot, "exports"),
    shareDir: join(dataRoot, "share"),
    workspacesDir: join(dataRoot, "workspaces"),
    cueVersionCacheFile: sparkRoot
      ? join(cacheRoot, "cache", "cued-version.json")
      : join(cacheRoot, "cued-version.json"),
  };
}

export function resolveSparkPaths(options: ResolveSparkPathsOptions): SparkPaths {
  return resolveAppPaths(options.app, appDatabaseNames[options.app], options);
}

function resolveAppPaths<App extends SparkApp>(
  app: App,
  databaseName: string,
  options: ResolveSparkHomeOptions & { overrides?: SparkPathOverrides },
): SparkPaths<App> {
  const cwd = options.cwd ?? process.cwd();
  const overrides = options.overrides ?? {};
  const user = resolveSparkUserPaths(options);
  const unifiedRoot = Boolean(
    nonEmpty(options.sparkHome) ?? nonEmpty((options.env ?? process.env).SPARK_HOME),
  );
  const appConfigRoot = unifiedRoot ? join(user.configRoot, "apps", app) : user.configRoot;
  const appDataRoot = unifiedRoot
    ? join(user.dataRoot, "apps", app, "data")
    : join(user.dataRoot, app);
  const appCacheRoot = unifiedRoot
    ? join(user.cacheRoot, "apps", app, "cache")
    : join(user.cacheRoot, app);
  const appStateRoot = unifiedRoot
    ? join(user.stateRoot, "apps", app, "state")
    : join(user.stateRoot, app);
  const appRuntimeRoot = unifiedRoot
    ? join(user.runtimeRoot, "apps", app, "run")
    : nonEmpty((options.env ?? process.env).XDG_RUNTIME_DIR)
      ? join(user.runtimeRoot, app)
      : join(appStateRoot, "run");
  const configDir = appConfigRoot;
  const defaultConfigFile = unifiedRoot
    ? join(appConfigRoot, "config.toml")
    : join(appConfigRoot, `${app}.toml`);

  const configFile = absolutePath(overrides.configFile ?? defaultConfigFile, cwd);
  const dataDir = absolutePath(overrides.dataDir ?? appDataRoot, cwd);
  const cacheDir = absolutePath(overrides.cacheDir ?? appCacheRoot, cwd);
  const stateDir = absolutePath(overrides.stateDir ?? appStateRoot, cwd);
  const runtimeDir = absolutePath(overrides.runtimeDir ?? appRuntimeRoot, cwd);
  const artifactCacheDir = join(cacheDir, "artifacts");

  return {
    app,
    configDir,
    configFile,
    dataDir,
    cacheDir,
    stateDir,
    runtimeDir,
    databasePath: join(dataDir, databaseName),
    artifactCacheDir,
    artifactBlobsDir:
      app === "daemon"
        ? join(dataDir, "artifacts", "blobs", "sha256")
        : join(artifactCacheDir, "blobs", "sha256"),
    sessionRuntimeDir: app === "daemon" ? join(dataDir, "pi-agent") : undefined,
    logDir: join(stateDir, "logs"),
    logFile: join(stateDir, "logs", `${app}.jsonl`),
    pidFile: join(runtimeDir, `${app}.pid`),
  };
}

function xdgRoot(value: string | undefined, home: string, fallback: string, cwd: string): string {
  return absolutePath(nonEmpty(value) ?? join(home, fallback), cwd);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function absolutePath(path: string, cwd: string): string {
  return resolve(cwd, path);
}
