import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { SPARK_PROTOCOL_VERSION } from "@zendev-lab/spark-protocol";
import { resolveRenamedEnvironmentVariable } from "@zendev-lab/spark-system";

import { isSparkBuildInfo, readSparkBuildInfo } from "./build-info.ts";
import { readSparkUpdateConfig, writeSparkUpdateConfig } from "./config.ts";
import {
  detectSparkInstallation,
  isPackageManagerMethod,
  packageManagerUpdateCommand,
} from "./installation.ts";
import {
  nextUpdateRetryAt,
  readSparkUpdateState,
  resolveSparkUpdatePaths,
  withSparkUpdateLock,
  writeSparkUpdateState,
} from "./state.ts";
import type {
  SparkBuildInfo,
  SparkInstallation,
  SparkQuarantinedVersion,
  SparkUpdateConfig,
  SparkUpdatePaths,
  SparkUpdateState,
  SparkUpdateStatus,
} from "./types.ts";

const PACKAGE_NAME = "@zendev-lab/spark";
const REGISTRY_URL = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 15_000;
const MINIMUM_FREE_BYTES = 512 * 1024 * 1024;
const HEALTH_CHECK_COUNT = 3;

export interface SparkUpdateManagerOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  prefix?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  run?: typeof runCommand;
  buildInfo?: SparkBuildInfo;
  productRoot?: string;
  commandPath?: string;
  platform?: NodeJS.Platform;
}

export interface SparkAvailableRelease {
  version: string;
  integrity: string;
  tarball: string;
  nodeRequirement?: string;
  etag?: string;
  notModified?: boolean;
}

interface HubServiceSnapshot {
  running: boolean;
  url?: string;
}

export class SparkUpdateManager {
  readonly paths: SparkUpdatePaths;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;
  readonly #run: typeof runCommand;
  #buildInfo: SparkBuildInfo;
  readonly #productRoot: string | undefined;
  readonly #commandPath: string | undefined;
  readonly #platform: NodeJS.Platform;

  constructor(options: SparkUpdateManagerOptions = {}) {
    this.#env = options.env ?? process.env;
    this.paths = resolveSparkUpdatePaths({
      env: this.#env,
      cwd: options.cwd,
      prefix: options.prefix,
    });
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#run = options.run ?? runCommand;
    this.#buildInfo = options.buildInfo ?? readSparkBuildInfo({ env: this.#env, cwd: options.cwd });
    this.#productRoot =
      options.productRoot ??
      (this.#env.SPARK_PRODUCT_DIST ? dirname(this.#env.SPARK_PRODUCT_DIST) : undefined);
    this.#commandPath = options.commandPath;
    this.#platform = options.platform ?? process.platform;
  }

  private resolveInstallation(
    managed: boolean,
    channel: SparkUpdateConfig["channel"],
    managedVersion?: string,
  ): SparkInstallation {
    return detectSparkInstallation({
      managed,
      version: managed ? managedVersion : this.#buildInfo.version,
      channel,
      env: this.#env,
      productRoot: this.#productRoot,
      packageName: this.#buildInfo.packageName,
      commandPath: managed ? this.paths.launcherPath : this.#commandPath,
      platform: this.#platform,
    });
  }

  async status(): Promise<SparkUpdateStatus> {
    const [config, state] = await Promise.all([
      readSparkUpdateConfig(this.paths, this.#env),
      readSparkUpdateState(this.paths),
    ]);
    const managed = await isManagedCurrentLink(this.paths);
    const installation = this.resolveInstallation(managed, config.channel, state.currentVersion);
    const usesRuntimeBuild =
      installation.method === "container" || isPackageManagerMethod(installation.method);
    const effectiveState =
      usesRuntimeBuild && installation.version
        ? {
            ...state,
            currentVersion: installation.version,
            currentFingerprint: this.#buildInfo.fingerprint,
          }
        : state;
    const status: SparkUpdateStatus = {
      managed,
      installation,
      config,
      state: effectiveState,
      paths: this.paths,
    };
    if (installation.method === "source" || installation.method === "unknown") {
      status.repairCommand = `spark install --managed --prefix ${JSON.stringify(dirname(dirname(this.paths.launcherPath)))}`;
    }
    return status;
  }

  async configure(change: Partial<SparkUpdateConfig>): Promise<SparkUpdateConfig> {
    const current = await readSparkUpdateConfig(this.paths, this.#env);
    const next = { ...current, ...change };
    await writeSparkUpdateConfig(this.paths, next);
    if (this.#platform === "darwin") await this.installMacUpdaterJob(next);
    return next;
  }

  async check(options: { background?: boolean } = {}): Promise<SparkUpdateStatus> {
    return await withSparkUpdateLock(this.paths, async () => await this.checkLocked(options));
  }

  private async checkLocked(options: { background?: boolean }): Promise<SparkUpdateStatus> {
    const config = await readSparkUpdateConfig(this.paths, this.#env);
    if (options.background && config.policy === "manual") return await this.status();
    const state = await readSparkUpdateState(this.paths);
    const managed = await isManagedCurrentLink(this.paths);
    const installation = this.resolveInstallation(managed, config.channel, state.currentVersion);
    const usesRuntimeBuild =
      installation.method === "container" || isPackageManagerMethod(installation.method);
    const currentVersion = usesRuntimeBuild ? installation.version : state.currentVersion;
    if (options.background && !isNetworkCheckDue(config, state, this.#now())) {
      return await this.status();
    }
    let release: SparkAvailableRelease;
    try {
      release = await this.queryRegistry(config.channel, state.registryEtag);
    } catch (error) {
      await this.recordFailure("registry_check_failed", error);
      throw error;
    }
    let nextState: SparkUpdateState = {
      ...state,
      ...(currentVersion ? { currentVersion } : {}),
      ...(usesRuntimeBuild && currentVersion
        ? { currentFingerprint: this.#buildInfo.fingerprint }
        : {}),
      lastCheckAt: this.#now().toISOString(),
      ...(release.etag ? { registryEtag: release.etag } : {}),
      failure: undefined,
    };
    if (!release.notModified) {
      nextState.availableVersion = release.version === currentVersion ? undefined : release.version;
    }
    if (
      options.background &&
      config.policy === "notify" &&
      release.version &&
      release.version !== currentVersion &&
      state.lastAvailableNotifiedVersion !== release.version &&
      (await this.notifyAvailableVersion(release.version))
    ) {
      nextState = {
        ...nextState,
        lastAvailableNotifiedVersion: release.version,
        lastAvailableNotifiedAt: this.#now().toISOString(),
      };
    }
    await writeSparkUpdateState(this.paths, nextState);
    if (
      options.background &&
      config.policy === "auto" &&
      release.version &&
      release.version !== currentVersion &&
      canAutomaticallyApply(currentVersion, release.version) &&
      !isQuarantined(nextState, release.version)
    ) {
      if (managed) {
        return await this.applyLocked(release.version, { automatic: true, wait: true });
      }
      if (
        installation.automaticUpdates &&
        installation.commandPath &&
        isPackageManagerMethod(installation.method) &&
        (await this.daemonIsProvablyIdle(installation.commandPath))
      ) {
        return await this.applyPackageManagerLocked(release.version, installation, {
          automatic: true,
          wait: true,
        });
      }
    }
    return await this.status();
  }

  async installManaged(version?: string): Promise<SparkUpdateStatus> {
    await mkdir(dirname(this.paths.launcherPath), { recursive: true });
    await this.writeStableLauncher();
    const config = await readSparkUpdateConfig(this.paths, this.#env);
    const target = version ?? (await this.queryRegistry(config.channel)).version;
    await this.apply(target, { initialInstall: true, wait: true });
    if (this.#platform === "darwin") {
      await this.installMacUpdaterJob(config);
    }
    return await this.status();
  }

  async apply(
    requestedVersion?: string,
    options: { automatic?: boolean; initialInstall?: boolean; wait?: boolean } = {},
  ): Promise<SparkUpdateStatus> {
    return await withSparkUpdateLock(this.paths, async () => {
      if (options.initialInstall || (await isManagedCurrentLink(this.paths))) {
        return await this.applyLocked(requestedVersion, options);
      }
      const status = await this.status();
      if (status.installation.commandPath && isPackageManagerMethod(status.installation.method)) {
        return await this.applyPackageManagerLocked(requestedVersion, status.installation, options);
      }
      throw new Error(
        "This Spark installation cannot update itself. Use the reported package-manager command or run `spark install --managed`.",
      );
    });
  }

  private async applyLocked(
    requestedVersion: string | undefined,
    options: { automatic?: boolean; initialInstall?: boolean; wait?: boolean },
  ): Promise<SparkUpdateStatus> {
    const config = await readSparkUpdateConfig(this.paths, this.#env);
    let state = await readSparkUpdateState(this.paths);
    if (!options.initialInstall && !(await isManagedCurrentLink(this.paths))) {
      throw new Error(
        "This Spark installation is not managed. Run `spark install --managed` first; source checkouts are never modified.",
      );
    }
    const target = await this.resolveApplyTarget(requestedVersion, state, config.channel);
    const version = target.version;
    requireExactVersion(version);
    if (isQuarantined(state, version)) {
      throw new Error(
        `Spark ${version} is quarantined. Run \`spark update retry ${version} --yes\` before applying it again.`,
      );
    }
    if (options.automatic && !canAutomaticallyApply(state.currentVersion, version)) {
      state = { ...state, availableVersion: version };
      await writeSparkUpdateState(this.paths, state);
      return await this.status();
    }
    try {
      const candidate = await this.prepareApplyCandidate(target);
      return await this.activateCandidate(version, candidate, state, options);
    } catch (error) {
      await this.quarantine(version, error);
      await this.recordFailure("update_apply_failed", error, version);
      throw error;
    }
  }

  private async applyPackageManagerLocked(
    requestedVersion: string | undefined,
    installation: SparkInstallation,
    options: { automatic?: boolean; wait?: boolean },
  ): Promise<SparkUpdateStatus> {
    if (!installation.commandPath || !isPackageManagerMethod(installation.method)) {
      throw new Error("Spark cannot locate the package-manager installation command");
    }
    const config = await readSparkUpdateConfig(this.paths, this.#env);
    const state = await readSparkUpdateState(this.paths);
    const currentVersion = installation.version;
    if (!currentVersion) throw new Error("Spark cannot identify the installed version");
    const release = requestedVersion
      ? await this.queryExactVersion(requestedVersion)
      : await this.queryRegistry(config.channel);
    const version = release.version;
    requireExactVersion(version);
    if (version === currentVersion) {
      await writeSparkUpdateState(this.paths, {
        ...state,
        currentVersion,
        currentFingerprint: this.#buildInfo.fingerprint,
        availableVersion: undefined,
        pendingVersion: undefined,
        pendingFingerprint: undefined,
      });
      return await this.status();
    }
    if (isQuarantined(state, version)) {
      throw new Error(
        `Spark ${version} is quarantined. Run \`spark update retry ${version} --yes\` before applying it again.`,
      );
    }
    if (options.automatic && !canAutomaticallyApply(currentVersion, version)) {
      await writeSparkUpdateState(this.paths, { ...state, availableVersion: version });
      return await this.status();
    }
    if (options.automatic && !(await this.daemonIsProvablyIdle(installation.commandPath))) {
      await writeSparkUpdateState(this.paths, { ...state, availableVersion: version });
      return await this.status();
    }

    const hub = await this.readHubService(installation.commandPath);
    const previousFingerprint = this.#buildInfo.fingerprint;
    let packageChanged = false;
    await writeSparkUpdateState(this.paths, {
      ...state,
      currentVersion,
      currentFingerprint: this.#buildInfo.fingerprint,
      availableVersion: version,
      pendingVersion: version,
    });
    try {
      const update = packageManagerUpdateCommand(
        installation.method,
        version,
        installation.commandPath,
        this.#buildInfo.packageName,
      );
      const result = await this.#run(update.command, update.args, {
        env: this.#env,
        timeoutMs: 120_000,
      });
      if (result.code !== 0) {
        throw new Error(`${installation.method} update failed: ${result.stderr.trim()}`);
      }
      packageChanged = true;
      const build = await this.readBuildInfoFromLauncher(installation.commandPath);
      if (build.version !== version) {
        throw new Error(
          `${installation.method} installed Spark ${build.version}, expected ${version}`,
        );
      }
      this.#buildInfo = build;
      await writeSparkUpdateState(this.paths, {
        ...(await readSparkUpdateState(this.paths)),
        currentVersion: version,
        currentFingerprint: build.fingerprint,
        rollbackVersion: currentVersion,
        rollbackFingerprint: previousFingerprint,
      });
      if (options.wait !== false) {
        await this.syncDaemon(build, installation.commandPath);
        const hubUrl = await this.restartHubService(installation.commandPath, hub);
        await this.healthCheck(build, installation.commandPath);
        await this.healthCheckHub(hubUrl);
      }
      await writeSparkUpdateState(this.paths, {
        ...(await readSparkUpdateState(this.paths)),
        currentVersion: version,
        currentFingerprint: build.fingerprint,
        lastGoodVersion: version,
        lastGoodFingerprint: build.fingerprint,
        rollbackVersion: currentVersion,
        rollbackFingerprint: previousFingerprint,
        availableVersion: undefined,
        pendingVersion: undefined,
        pendingFingerprint: undefined,
        failure: undefined,
      });
      return await this.status();
    } catch (error) {
      if (packageChanged) {
        try {
          await this.restorePackageManagerVersion(installation, currentVersion, hub);
        } catch (rollbackError) {
          error = new AggregateError(
            [error, rollbackError],
            `Spark ${version} failed and restoring ${currentVersion} also failed`,
          );
        }
      }
      await this.quarantine(version, error);
      await this.recordFailure("package_manager_update_failed", error, version);
      throw error;
    }
  }

  private async resolveApplyTarget(
    requestedVersion: string | undefined,
    state: SparkUpdateState,
    channel: SparkUpdateConfig["channel"],
  ): Promise<{
    version: string;
    candidate?: SparkBuildInfo;
    release?: SparkAvailableRelease;
  }> {
    if (requestedVersion && requestedVersion === state.pendingVersion) {
      const candidate = await readReadyCandidate(
        this.paths,
        requestedVersion,
        state.pendingFingerprint,
      );
      if (candidate) return { version: requestedVersion, candidate };
    }
    try {
      const release = requestedVersion
        ? await this.queryExactVersion(requestedVersion)
        : await this.queryRegistry(channel);
      return { version: release.version, release };
    } catch (error) {
      await this.recordFailure("release_resolution_failed", error, requestedVersion);
      throw error;
    }
  }

  private async prepareApplyCandidate(target: {
    version: string;
    candidate?: SparkBuildInfo;
    release?: SparkAvailableRelease;
  }): Promise<SparkBuildInfo> {
    if (target.candidate) return target.candidate;
    if (!target.release) {
      throw new Error(`Missing immutable release metadata for Spark ${target.version}`);
    }
    return await this.stageAndVerify(target.release);
  }

  private async activateCandidate(
    version: string,
    candidate: SparkBuildInfo,
    initialState: SparkUpdateState,
    options: { automatic?: boolean; wait?: boolean },
  ): Promise<SparkUpdateStatus> {
    let state: SparkUpdateState = {
      ...initialState,
      availableVersion: version,
      pendingVersion: version,
      pendingFingerprint: candidate.fingerprint,
    };
    await writeSparkUpdateState(this.paths, state);
    if (options.automatic && !(await this.daemonIsProvablyIdle())) {
      return await this.status();
    }
    const hub = await this.readHubService(this.paths.launcherPath);
    const previousVersion = state.currentVersion;
    const previousFingerprint = state.currentFingerprint;
    await this.activateVersion(version);
    state = {
      ...state,
      currentVersion: version,
      currentFingerprint: candidate.fingerprint,
      ...(previousVersion ? { rollbackVersion: previousVersion } : {}),
      ...(previousFingerprint ? { rollbackFingerprint: previousFingerprint } : {}),
    };
    await writeSparkUpdateState(this.paths, state);
    try {
      await this.verifyCandidateWhenRequested(candidate, options.wait, hub);
    } catch (error) {
      await this.restoreAfterFailedActivation(
        error,
        version,
        previousVersion,
        previousFingerprint,
        hub,
      );
      throw error;
    }
    await writeSparkUpdateState(this.paths, {
      ...state,
      lastGoodVersion: version,
      lastGoodFingerprint: candidate.fingerprint,
      ...(previousVersion ? { rollbackVersion: previousVersion } : {}),
      ...(previousFingerprint ? { rollbackFingerprint: previousFingerprint } : {}),
      availableVersion: undefined,
      pendingVersion: undefined,
      pendingFingerprint: undefined,
      failure: undefined,
    });
    await this.cleanupVersions(new Set([version, previousVersion].filter(Boolean) as string[]));
    return await this.status();
  }

  private async verifyCandidateWhenRequested(
    candidate: SparkBuildInfo,
    wait: boolean | undefined,
    hub: HubServiceSnapshot,
  ): Promise<void> {
    if (wait === false) return;
    await this.syncDaemon(candidate);
    const hubUrl = await this.restartHubService(this.paths.launcherPath, hub);
    await this.healthCheck(candidate);
    await this.healthCheckHub(hubUrl);
  }

  private async restoreAfterFailedActivation(
    error: unknown,
    failedVersion: string,
    previousVersion: string | undefined,
    previousFingerprint: string | undefined,
    hub: HubServiceSnapshot,
  ): Promise<void> {
    if (!previousVersion) {
      await this.stopFailedInitialInstall();
      return;
    }
    await this.activateVersion(previousVersion);
    const previousBuild = await readInstalledBuildInfo(this.paths, previousVersion);
    await writeSparkUpdateState(this.paths, {
      ...(await readSparkUpdateState(this.paths)),
      currentVersion: previousVersion,
      currentFingerprint: previousFingerprint,
      pendingVersion: undefined,
      pendingFingerprint: undefined,
    });
    try {
      await this.syncDaemon(previousBuild);
      const hubUrl = await this.restartHubService(this.paths.launcherPath, hub);
      await this.healthCheck(previousBuild);
      await this.healthCheckHub(hubUrl);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Spark ${failedVersion} failed and rollback health verification also failed`,
      );
    }
  }

  private async stopFailedInitialInstall(): Promise<void> {
    await this.#run(this.paths.launcherPath, ["daemon", "stop", "--yes"], {
      env: this.#env,
      timeoutMs: 30_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    await rm(this.paths.currentLink, { force: true });
    await writeSparkUpdateState(this.paths, {
      ...(await readSparkUpdateState(this.paths)),
      currentVersion: undefined,
      currentFingerprint: undefined,
      pendingVersion: undefined,
      pendingFingerprint: undefined,
    });
  }

  async rollback(options: { wait?: boolean } = {}): Promise<SparkUpdateStatus> {
    return await withSparkUpdateLock(this.paths, async () => {
      const state = await readSparkUpdateState(this.paths);
      const target =
        state.rollbackVersion ??
        (state.lastGoodVersion !== state.currentVersion ? state.lastGoodVersion : undefined);
      if (!target) throw new Error("No rollback Spark version is available");
      if (!(await isManagedCurrentLink(this.paths))) {
        const status = await this.status();
        const installation = status.installation;
        if (!installation.commandPath || !isPackageManagerMethod(installation.method)) {
          throw new Error("This Spark installation cannot roll back automatically");
        }
        const previousVersion = installation.version;
        const previousFingerprint = status.state.currentFingerprint;
        const hub = await this.readHubService(installation.commandPath);
        const build = await this.restorePackageManagerVersion(installation, target, hub, {
          verify: options.wait !== false,
        });
        await writeSparkUpdateState(this.paths, {
          ...state,
          currentVersion: target,
          currentFingerprint: build.fingerprint,
          lastGoodVersion: target,
          lastGoodFingerprint: build.fingerprint,
          ...(previousVersion ? { rollbackVersion: previousVersion } : {}),
          ...(previousFingerprint ? { rollbackFingerprint: previousFingerprint } : {}),
          pendingVersion: undefined,
          pendingFingerprint: undefined,
          failure: undefined,
        });
        return await this.status();
      }
      const previousVersion = state.currentVersion;
      const previousFingerprint = state.currentFingerprint;
      const hub = await this.readHubService(this.paths.launcherPath);
      const build = await readInstalledBuildInfo(this.paths, target);
      await this.activateVersion(target);
      await writeSparkUpdateState(this.paths, {
        ...state,
        currentVersion: target,
        currentFingerprint: build.fingerprint,
        pendingVersion: undefined,
        pendingFingerprint: undefined,
      });
      try {
        if (options.wait !== false) {
          await this.syncDaemon(build);
          const hubUrl = await this.restartHubService(this.paths.launcherPath, hub);
          await this.healthCheck(build);
          await this.healthCheckHub(hubUrl);
        }
      } catch (error) {
        if (!previousVersion) throw error;
        await this.activateVersion(previousVersion);
        const previousBuild = await readInstalledBuildInfo(this.paths, previousVersion);
        await writeSparkUpdateState(this.paths, state);
        try {
          await this.syncDaemon(previousBuild);
          const hubUrl = await this.restartHubService(this.paths.launcherPath, hub);
          await this.healthCheck(previousBuild);
          await this.healthCheckHub(hubUrl);
        } catch (restoreError) {
          const aggregate = new AggregateError(
            [error, restoreError],
            `Rollback to Spark ${target} failed and restoring ${previousVersion} also failed`,
          );
          await this.recordFailure("update_rollback_failed", aggregate, target);
          throw aggregate;
        }
        await this.recordFailure("update_rollback_failed", error, target);
        throw error;
      }
      await writeSparkUpdateState(this.paths, {
        ...(await readSparkUpdateState(this.paths)),
        lastGoodVersion: target,
        lastGoodFingerprint: build.fingerprint,
        ...(previousVersion ? { rollbackVersion: previousVersion } : {}),
        ...(previousFingerprint ? { rollbackFingerprint: previousFingerprint } : {}),
        failure: undefined,
      });
      await this.cleanupVersions(new Set([target, previousVersion].filter(Boolean) as string[]));
      return await this.status();
    });
  }

  async retry(version?: string): Promise<SparkUpdateStatus> {
    return await withSparkUpdateLock(this.paths, async () => {
      const state = await readSparkUpdateState(this.paths);
      const target = version ?? state.availableVersion ?? state.pendingVersion;
      if (!target) throw new Error("No failed or available Spark version was selected");
      await writeSparkUpdateState(this.paths, {
        ...state,
        quarantined: state.quarantined.filter((entry) => entry.version !== target),
        failure: state.failure?.version === target ? undefined : state.failure,
      });
      if (await isManagedCurrentLink(this.paths)) {
        return await this.applyLocked(target, { wait: true });
      }
      const status = await this.status();
      if (status.installation.commandPath && isPackageManagerMethod(status.installation.method)) {
        return await this.applyPackageManagerLocked(target, status.installation, { wait: true });
      }
      throw new Error("This Spark installation cannot retry an update automatically");
    });
  }

  async tick(): Promise<SparkUpdateStatus> {
    const status = await this.status();
    const { config, state, installation } = status;
    const target = state.pendingVersion ?? state.availableVersion;
    if (
      config.policy === "auto" &&
      target &&
      !isQuarantined(state, target) &&
      canAutomaticallyApply(state.currentVersion, target) &&
      installation.commandPath &&
      (await this.daemonIsProvablyIdle(installation.commandPath))
    ) {
      return await this.apply(target, { automatic: true, wait: true });
    }
    return await this.check({ background: true });
  }

  async queryRegistry(channel: "latest" | "next", etag?: string): Promise<SparkAvailableRelease> {
    const url = `${REGISTRY_URL}/${encodeURIComponent(PACKAGE_NAME)}`;
    const response = await fetchWithRetry(
      this.#fetch,
      url,
      {
        headers: {
          accept: "application/vnd.npm.install-v1+json",
          ...(etag ? { "if-none-match": etag } : {}),
        },
      },
      REGISTRY_TIMEOUT_MS,
    );
    if (response.status === 304) {
      return {
        version: "",
        integrity: "",
        tarball: "",
        etag: response.headers.get("etag") ?? etag,
        notModified: true,
      };
    }
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const packument = (await response.json()) as NpmPackument;
    const version = packument["dist-tags"]?.[channel];
    if (!version) throw new Error(`npm package ${PACKAGE_NAME} has no ${channel} dist-tag`);
    return releaseFromPackument(packument, version, response.headers.get("etag") ?? undefined);
  }

  async queryExactVersion(version: string): Promise<SparkAvailableRelease> {
    requireExactVersion(version);
    const response = await fetchWithRetry(
      this.#fetch,
      `${REGISTRY_URL}/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
      { headers: { accept: "application/json" } },
      REGISTRY_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const metadata = (await response.json()) as NpmVersionMetadata;
    return releaseFromMetadata(metadata);
  }

  private async stageAndVerify(release: SparkAvailableRelease): Promise<SparkBuildInfo> {
    requireExactVersion(release.version);
    // A previous process may have died while staging. The updater lock makes
    // the whole staging root private to this transaction.
    await rm(this.paths.stagingDir, { recursive: true, force: true });
    await mkdir(this.paths.stagingDir, { recursive: true });
    const filesystem = await statfs(this.paths.stagingDir);
    if (filesystem.bavail * filesystem.bsize < MINIMUM_FREE_BYTES) {
      throw new Error("At least 512 MiB of free disk space is required for a Spark update");
    }
    const staging = join(this.paths.stagingDir, `${release.version}-${randomUUID()}`);
    await mkdir(staging, { recursive: true });
    try {
      const download = join(staging, "download");
      await mkdir(download);
      const packedResult = await this.#run(
        "npm",
        ["pack", `${PACKAGE_NAME}@${release.version}`, "--json", "--pack-destination", download],
        { env: this.#env, timeoutMs: 120_000 },
      );
      if (packedResult.code !== 0) {
        throw new Error(`npm pack failed: ${packedResult.stderr.trim()}`);
      }
      const packed = parseNpmPackResult(packedResult.stdout);
      if (packed.integrity !== release.integrity) {
        throw new Error(
          `Candidate npm integrity ${packed.integrity} does not match registry ${release.integrity}`,
        );
      }
      const result = await this.#run(
        "npm",
        [
          "install",
          "--prefix",
          staging,
          "--omit=dev",
          "--ignore-scripts",
          "--no-package-lock",
          "--no-save",
          join(download, packed.filename),
        ],
        { env: this.#env, timeoutMs: 120_000 },
      );
      if (result.code !== 0) throw new Error(`npm install failed: ${result.stderr.trim()}`);
      const build = await readBuildInfoFile(
        join(staging, "node_modules", "@zendev-lab", "spark", "dist", "build-info.json"),
      );
      if (build.version !== release.version) {
        throw new Error(
          `Candidate build-info version ${build.version} does not match ${release.version}`,
        );
      }
      if (build.protocolVersion !== SPARK_PROTOCOL_VERSION) {
        throw new Error(
          `Candidate protocol ${build.protocolVersion} is incompatible with ${SPARK_PROTOCOL_VERSION}`,
        );
      }
      assertNodeCompatible(build.minimumNodeVersion);
      if (build.migrationMode !== "expand-only") {
        throw new Error(
          `Spark ${release.version} requires a manually confirmed database migration`,
        );
      }
      const candidateBin = join(staging, "node_modules", "@zendev-lab", "spark", "bin", "spark");
      const smokeHome = join(staging, "smoke-home");
      const smoke = await this.#run(process.execPath, [candidateBin, "version", "--json"], {
        env: { ...this.#env, SPARK_HOME: smokeHome },
        timeoutMs: 30_000,
      });
      if (smoke.code !== 0) throw new Error(`Candidate smoke failed: ${smoke.stderr.trim()}`);
      const versionDir = join(this.paths.versionsDir, release.version);
      await mkdir(this.paths.versionsDir, { recursive: true });
      await rm(versionDir, { recursive: true, force: true });
      await rename(staging, versionDir);
      return build;
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async activateVersion(version: string): Promise<void> {
    const target = join(this.paths.versionsDir, version);
    await lstat(target);
    const temporary = join(this.paths.versionsDir, `.current-${process.pid}-${randomUUID()}`);
    await symlink(relative(this.paths.versionsDir, target), temporary, "dir");
    await rename(temporary, this.paths.currentLink);
  }

  private async writeStableLauncher(): Promise<void> {
    const launcher = `#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const launcherPath = __filename;
const versionsDir = ${JSON.stringify(this.paths.versionsDir)};
const packageRoot = resolve(versionsDir, "current", "node_modules", "@zendev-lab", "spark");
const target = resolve(packageRoot, "bin", "spark");
if (!existsSync(target)) {
  console.error("Spark managed installation is incomplete. Run: spark update status");
  process.exit(78);
}
process.env.SPARK_STABLE_LAUNCHER = launcherPath;
process.env.SPARK_DEPLOYMENT_WATCH_PATH = resolve(packageRoot, "dist", "build-info.json");
process.env.SPARK_MANAGED_VERSIONS_DIR = versionsDir;
process.env.SPARK_MANAGED_CONFIG_FILE = ${JSON.stringify(this.paths.configFile)};
process.env.SPARK_MANAGED_STATE_DIR = ${JSON.stringify(this.paths.stateDir)};
process.env.SPARK_MANAGED_CACHE_DIR = ${JSON.stringify(this.paths.cacheDir)};
const child = spawn(process.execPath, [target, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
`;
    await mkdir(dirname(this.paths.launcherPath), { recursive: true });
    const temporary = `${this.paths.launcherPath}.${process.pid}.tmp`;
    await writeFile(temporary, launcher);
    await chmod(temporary, 0o755);
    await rename(temporary, this.paths.launcherPath);
  }

  private async installMacUpdaterJob(config: SparkUpdateConfig): Promise<void> {
    if (this.#platform !== "darwin") return;
    const status = await this.status();
    const launcher = status.installation.commandPath;
    await mkdir(dirname(this.paths.updaterLaunchAgentPath), { recursive: true });
    const disabled = config.policy === "manual";
    const domain = `gui/${process.getuid?.() ?? 0}`;
    if (!launcher || !status.installation.automaticUpdates) {
      await this.#run("launchctl", ["bootout", domain, this.paths.updaterLaunchAgentPath], {
        env: this.#env,
        timeoutMs: 15_000,
      }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      if (disabled) {
        await rm(this.paths.updaterLaunchAgentPath, { force: true });
        return;
      }
      throw new Error(
        "Background updates require a managed or globally installed Spark command on PATH",
      );
    }
    const updaterPath = [dirname(launcher), this.#env.PATH].filter(Boolean).join(":");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.spark.updater</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(launcher)}</string>
    <string>update</string>
    <string>__tick</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${escapeXml(updaterPath)}</string></dict>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><${disabled ? "false" : "true"}/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
    const temporary = `${this.paths.updaterLaunchAgentPath}.${process.pid}.tmp`;
    await writeFile(temporary, plist);
    await rename(temporary, this.paths.updaterLaunchAgentPath);
    await this.#run("launchctl", ["bootout", domain, this.paths.updaterLaunchAgentPath], {
      env: this.#env,
      timeoutMs: 15_000,
    }).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (!disabled) {
      const loaded = await this.#run(
        "launchctl",
        ["bootstrap", domain, this.paths.updaterLaunchAgentPath],
        { env: this.#env, timeoutMs: 15_000 },
      );
      if (loaded.code !== 0) {
        throw new Error(`Failed to register Spark updater launchd job: ${loaded.stderr.trim()}`);
      }
    }
  }

  private async syncDaemon(
    build: SparkBuildInfo,
    launcher = this.paths.launcherPath,
  ): Promise<void> {
    const result = await this.#run(launcher, ["daemon", "sync", "--wait", "--json"], {
      env: this.#env,
      timeoutMs: 90_000,
    });
    if (result.code !== 0) throw new Error(`Daemon handoff failed: ${result.stderr.trim()}`);
    const payload = parseJsonOutput(result.stdout);
    const runningFingerprint = nestedString(payload, ["status", "build", "runningFingerprint"]);
    if (runningFingerprint && runningFingerprint !== build.fingerprint) {
      throw new Error(
        `Daemon successor reported ${runningFingerprint}, expected ${build.fingerprint}`,
      );
    }
  }

  private async healthCheck(
    build: SparkBuildInfo,
    launcher = this.paths.launcherPath,
  ): Promise<void> {
    for (let index = 0; index < HEALTH_CHECK_COUNT; index += 1) {
      const result = await this.#run(launcher, ["daemon", "status", "--json"], {
        env: this.#env,
        timeoutMs: 30_000,
      });
      if (result.code !== 0) throw new Error(`Daemon health check failed: ${result.stderr.trim()}`);
      const payload = parseJsonOutput(result.stdout);
      const fingerprint =
        nestedString(payload, ["build", "runningFingerprint"]) ??
        nestedString(payload, ["status", "build", "runningFingerprint"]);
      if (fingerprint !== build.fingerprint) {
        throw new Error(
          `Daemon health fingerprint ${fingerprint ?? "missing"} does not match ${build.fingerprint}`,
        );
      }
    }
  }

  private async daemonIsProvablyIdle(launcher = this.paths.launcherPath): Promise<boolean> {
    const result = await this.#run(launcher, ["daemon", "status", "--json"], {
      env: this.#env,
      timeoutMs: 15_000,
    });
    if (result.code !== 0) return false;
    const payload = parseJsonOutput(result.stdout);
    const running =
      nestedNumber(payload, ["invocations", "running"]) ??
      nestedNumber(payload, ["status", "invocations", "running"]);
    const queued =
      nestedNumber(payload, ["invocations", "queued"]) ??
      nestedNumber(payload, ["status", "invocations", "queued"]);
    return running === 0 && queued === 0;
  }

  private async healthCheckHub(hubUrl?: string): Promise<void> {
    const healthUrl =
      hubUrl ??
      resolveRenamedEnvironmentVariable(this.#env, {
        canonical: "SPARK_HUB_HEALTH_URL",
        legacy: "SPARK_COCKPIT_HEALTH_URL",
      });
    if (!healthUrl) return;
    const response = await this.#fetch(healthUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json()) as { service?: unknown; status?: unknown };
    if (
      !response.ok ||
      (body.service !== "spark-hub" && body.service !== "spark-cockpit") ||
      body.status !== "ok"
    ) {
      throw new Error(`Spark Hub health check failed at ${healthUrl}`);
    }
  }

  private async readBuildInfoFromLauncher(launcher: string): Promise<SparkBuildInfo> {
    const result = await this.#run(launcher, ["version", "--json"], {
      env: this.#env,
      timeoutMs: 30_000,
    });
    if (result.code !== 0) {
      throw new Error(`Updated Spark version check failed: ${result.stderr.trim()}`);
    }
    const parsed = parseJsonOutput(result.stdout);
    if (!isSparkBuildInfo(parsed)) throw new Error("Updated Spark returned invalid build metadata");
    return parsed;
  }

  private async readHubService(launcher: string): Promise<HubServiceSnapshot> {
    try {
      const result = await this.runHubWebCommand(launcher, "status", 15_000);
      if (result.code !== 0) return { running: false };
      const parsed = parseJsonOutput(result.stdout);
      if (!parsed || typeof parsed !== "object") return { running: false };
      const record = parsed as Record<string, unknown>;
      return {
        running: record.running === true,
        ...(typeof record.url === "string" ? { url: record.url } : {}),
      };
    } catch {
      return { running: false };
    }
  }

  private async restartHubService(
    launcher: string,
    previous: HubServiceSnapshot,
  ): Promise<string | undefined> {
    if (!previous.running) return undefined;
    const stopped = await this.runHubWebCommand(launcher, "stop", 30_000);
    if (stopped.code !== 0) {
      throw new Error(`Spark Hub stop failed: ${stopped.stderr.trim()}`);
    }
    const started = await this.runHubWebCommand(launcher, "start", 30_000);
    if (started.code !== 0) {
      throw new Error(`Spark Hub start failed: ${started.stderr.trim()}`);
    }
    const parsed = parseJsonOutput(started.stdout);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as Record<string, unknown>).running !== true
    ) {
      throw new Error("Spark Hub did not report a running replacement");
    }
    const url = (parsed as Record<string, unknown>).url;
    return typeof url === "string" ? url : previous.url;
  }

  private async runHubWebCommand(
    launcher: string,
    action: "start" | "status" | "stop",
    timeoutMs: number,
  ): Promise<Awaited<ReturnType<typeof runCommand>>> {
    const canonical = await this.#run(launcher, ["hub", "web", action, "--json"], {
      env: this.#env,
      timeoutMs,
    });
    if (canonical.code === 0) return canonical;

    // Published Cockpit builds predate the Hub namespace. This fallback is
    // updater-only and never exposes Cockpit through the current dispatcher.
    const legacy = await this.#run(launcher, ["cockpit", "web", action, "--json"], {
      env: this.#env,
      timeoutMs,
    });
    return legacy.code === 0 ? legacy : canonical;
  }

  private async restorePackageManagerVersion(
    installation: SparkInstallation,
    version: string,
    hub: HubServiceSnapshot,
    options: { verify?: boolean } = {},
  ): Promise<SparkBuildInfo> {
    if (!installation.commandPath || !isPackageManagerMethod(installation.method)) {
      throw new Error("Spark cannot restore this package-manager installation");
    }
    const update = packageManagerUpdateCommand(
      installation.method,
      version,
      installation.commandPath,
      this.#buildInfo.packageName,
    );
    const result = await this.#run(update.command, update.args, {
      env: this.#env,
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      throw new Error(`${installation.method} rollback failed: ${result.stderr.trim()}`);
    }
    const build = await this.readBuildInfoFromLauncher(installation.commandPath);
    if (build.version !== version) {
      throw new Error(
        `${installation.method} restored Spark ${build.version}, expected ${version}`,
      );
    }
    this.#buildInfo = build;
    if (options.verify !== false) {
      await this.syncDaemon(build, installation.commandPath);
      const hubUrl = await this.restartHubService(installation.commandPath, hub);
      await this.healthCheck(build, installation.commandPath);
      await this.healthCheckHub(hubUrl);
    }
    return build;
  }

  private async notifyAvailableVersion(version: string): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    const result = await this.#run(
      "osascript",
      [
        "-e",
        `display notification "Spark ${version} is available. Run spark update apply ${version} --yes --wait" with title "Spark update available"`,
      ],
      { env: this.#env, timeoutMs: 10_000 },
    ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    return result.code === 0;
  }

  private async quarantine(version: string, error: unknown): Promise<void> {
    const state = await readSparkUpdateState(this.paths);
    const entry: SparkQuarantinedVersion = {
      version,
      reason: errorMessage(error),
      quarantinedAt: this.#now().toISOString(),
    };
    await writeSparkUpdateState(this.paths, {
      ...state,
      quarantined: [...state.quarantined.filter((item) => item.version !== version), entry],
    });
  }

  private async recordFailure(code: string, error: unknown, version?: string): Promise<void> {
    const state = await readSparkUpdateState(this.paths);
    const now = this.#now();
    const same = state.failure?.code === code && state.failure?.version === version;
    const count = same ? state.failure!.count + 1 : 1;
    const logDue = !same || elapsedAtLeast(state.failure?.lastLoggedAt, now, 60 * 60_000);
    const notificationDue =
      !same || elapsedAtLeast(state.failure?.lastNotifiedAt, now, 24 * 60 * 60_000);
    const lastLoggedAt = retainedTimestamp(logDue, state.failure?.lastLoggedAt, now);
    const lastNotifiedAt = retainedTimestamp(notificationDue, state.failure?.lastNotifiedAt, now);
    await writeSparkUpdateState(this.paths, {
      ...state,
      failure: {
        ...(version ? { version } : {}),
        code,
        message: errorMessage(error),
        count,
        firstAt: same ? state.failure!.firstAt : now.toISOString(),
        lastAt: now.toISOString(),
        nextRetryAt: nextUpdateRetryAt(count, now),
        ...(lastLoggedAt ? { lastLoggedAt } : {}),
        ...(lastNotifiedAt ? { lastNotifiedAt } : {}),
      },
    });
    if (logDue) console.error(`[spark-update] ${code}: ${errorMessage(error)}`);
    if (notificationDue && process.platform === "darwin") {
      const message = errorMessage(error).replaceAll('"', "'").slice(0, 180);
      await this.#run(
        "osascript",
        ["-e", `display notification "${message}" with title "Spark update failed"`],
        { env: this.#env, timeoutMs: 10_000 },
      ).catch(() => ({ code: 1, stdout: "", stderr: "" }));
    }
  }

  private async cleanupVersions(keep: Set<string>): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.versionsDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "current" || entry.startsWith(".current-") || keep.has(entry)) continue;
      await rm(join(this.paths.versionsDir, entry), { recursive: true, force: true });
    }
  }
}

interface NpmVersionMetadata {
  version?: string;
  dist?: { integrity?: string; tarball?: string };
  engines?: { node?: string };
}

interface NpmPackument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, NpmVersionMetadata>;
}

interface NpmPackResult {
  filename: string;
  integrity: string;
}

function releaseFromPackument(
  packument: NpmPackument,
  version: string,
  etag?: string,
): SparkAvailableRelease {
  const release = releaseFromMetadata(packument.versions?.[version]);
  return { ...release, ...(etag ? { etag } : {}) };
}

function releaseFromMetadata(metadata: NpmVersionMetadata | undefined): SparkAvailableRelease {
  if (
    !metadata ||
    typeof metadata.version !== "string" ||
    typeof metadata.dist?.integrity !== "string" ||
    typeof metadata.dist.tarball !== "string"
  ) {
    throw new Error("npm registry returned incomplete Spark release metadata");
  }
  requireExactVersion(metadata.version);
  return {
    version: metadata.version,
    integrity: metadata.dist.integrity,
    tarball: metadata.dist.tarball,
    ...(metadata.engines?.node ? { nodeRequirement: metadata.engines.node } : {}),
  };
}

function parseNpmPackResult(output: string): NpmPackResult {
  const parsed = JSON.parse(output) as unknown;
  const candidate = Array.isArray(parsed) ? parsed[0] : undefined;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as Record<string, unknown>).filename !== "string" ||
    typeof (candidate as Record<string, unknown>).integrity !== "string"
  ) {
    throw new Error("npm pack returned invalid integrity metadata");
  }
  return {
    filename: (candidate as Record<string, string>).filename,
    integrity: (candidate as Record<string, string>).integrity,
  };
}

async function fetchWithRetry(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImplementation(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (
        attempt === 0 &&
        (response.status === 408 || response.status === 429 || response.status >= 500)
      ) {
        await response.body?.cancel();
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function canAutomaticallyApply(current: string | undefined, target: string): boolean {
  if (!current) return true;
  const currentParts = parseVersion(current);
  const targetParts = parseVersion(target);
  if (currentParts.major === 0 && currentParts.minor !== targetParts.minor) return false;
  return compareVersions(targetParts, currentParts) > 0;
}

export function isNetworkCheckDue(
  config: Pick<SparkUpdateConfig, "checkIntervalHours">,
  state: Pick<SparkUpdateState, "lastCheckAt" | "failure">,
  now: Date,
): boolean {
  if (state.failure && new Date(state.failure.nextRetryAt).getTime() > now.getTime()) return false;
  if (!state.lastCheckAt) return true;
  const jitterMinutes = deterministicJitterMinutes(state.lastCheckAt, 30);
  const dueAt =
    new Date(state.lastCheckAt).getTime() +
    config.checkIntervalHours * 60 * 60_000 +
    jitterMinutes * 60_000;
  return now.getTime() >= dueAt;
}

function deterministicJitterMinutes(seed: string, maximum: number): number {
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  return hash % (maximum + 1);
}

function retainedTimestamp(
  due: boolean,
  previous: string | undefined,
  now: Date,
): string | undefined {
  return due ? now.toISOString() : previous;
}

function elapsedAtLeast(value: string | undefined, now: Date, durationMs: number): boolean {
  return !value || now.getTime() - new Date(value).getTime() >= durationMs;
}

function parseVersion(version: string): {
  major: number;
  minor: number;
  patch: number;
  raw: string;
} {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) throw new Error(`Expected an exact semantic version, received: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: version,
  };
}

function compareVersions(
  left: ReturnType<typeof parseVersion>,
  right: ReturnType<typeof parseVersion>,
): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function requireExactVersion(version: string): void {
  parseVersion(version);
}

function assertNodeCompatible(requirement: string): void {
  const minimumMajor = />=(\d+)/u.exec(requirement)?.[1];
  const maximumMajor = /<(\d+)/u.exec(requirement)?.[1];
  const currentMajor = Number(process.versions.node.split(".")[0]);
  if (
    (minimumMajor && currentMajor < Number(minimumMajor)) ||
    (maximumMajor && currentMajor >= Number(maximumMajor))
  ) {
    throw new Error(`Spark requires Node ${requirement}; current Node is ${process.versions.node}`);
  }
}

async function readInstalledBuildInfo(
  paths: SparkUpdatePaths,
  version: string,
): Promise<SparkBuildInfo> {
  return await readBuildInfoFile(
    join(
      paths.versionsDir,
      version,
      "node_modules",
      "@zendev-lab",
      "spark",
      "dist",
      "build-info.json",
    ),
  );
}

async function readReadyCandidate(
  paths: SparkUpdatePaths,
  version: string,
  expectedFingerprint: string | undefined,
): Promise<SparkBuildInfo | undefined> {
  if (!expectedFingerprint) return undefined;
  try {
    const build = await readInstalledBuildInfo(paths, version);
    return build.version === version && build.fingerprint === expectedFingerprint
      ? build
      : undefined;
  } catch {
    return undefined;
  }
}

async function readBuildInfoFile(path: string): Promise<SparkBuildInfo> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isSparkBuildInfo(parsed)) throw new Error(`Invalid Spark build-info: ${path}`);
  return parsed;
}

async function isManagedCurrentLink(paths: SparkUpdatePaths): Promise<boolean> {
  try {
    const stats = await lstat(paths.currentLink);
    if (!stats.isSymbolicLink()) return false;
    const target = await readlink(paths.currentLink);
    return !target.startsWith("..") && basename(target) !== "current";
  } catch {
    return false;
  }
}

function isQuarantined(state: SparkUpdateState, version: string): boolean {
  return state.quarantined.some((entry) => entry.version === version);
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const line = trimmed.split(/\r?\n/u).findLast((candidate) => candidate.startsWith("{"));
    return line ? JSON.parse(line) : {};
  }
}

function nestedString(value: unknown, path: string[]): string | undefined {
  const nested = nestedValue(value, path);
  return typeof nested === "string" ? nested : undefined;
}

function nestedNumber(value: unknown, path: string[]): number | undefined {
  const nested = nestedValue(value, path);
  return typeof nested === "number" ? nested : undefined;
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
