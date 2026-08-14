export interface ReleaseMigrationArguments {
  candidateTarball: string;
  baselineVersion?: string;
  cliTarball?: string;
  daemonTarball?: string;
  hubTarball?: string;
  tuiTarball?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface MigrationCommandOptions {
  env: Record<string, string>;
}

export function parseMigrationArguments(argv: string[]): ReleaseMigrationArguments;

export function selectPublishedBaselineVersion(
  published: string | string[],
  currentVersion: string,
  explicitVersion?: string,
): string | undefined;

export function resolveReleaseMigrationExemption(
  sparkRelease: unknown,
  candidateVersion: string,
): { candidateVersion: string; reason: string } | undefined;

export function resolvePublishedHubProbe(
  baselineRoot: string,
  dependencies?: { exists?: (path: string) => boolean | Promise<boolean> },
): Promise<{ command: string; listArgs: string[] }>;

export function readCandidateArtifactIdentity(
  candidatePath: string,
  expectedVersion: string,
  dependencies?: {
    readArchiveEntry?: (entry: string) => string | undefined | Promise<string | undefined>;
  },
): Promise<{ packageName: "@zendev-lab/spark"; version: string }>;

export function assertCandidateArtifactIdentity(input: {
  manifest: unknown;
  buildInfo: unknown;
  expectedVersion: string;
  candidatePath?: string;
}): { packageName: "@zendev-lab/spark"; version: string };

export interface MixedVersionIpcInput {
  baselineSpark: string;
  candidateSpark: string;
  temporaryRoot: string;
  baseEnv?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface MixedVersionIpcDependencies {
  runSpark?: (
    spark: string,
    args: string[],
    options: MigrationCommandOptions,
  ) => CommandResult | Promise<CommandResult>;
  log?: (message: string) => void;
  isProcessAlive?: (pid: number) => boolean;
  readProcessStartToken?: (pid: number) => string | null | Promise<string | null>;
  signalProcess?: (pid: number, signal: string) => void | Promise<void>;
  sleep?: (milliseconds: number) => void | Promise<void>;
  cleanupTimeoutMs?: number;
  cleanupPollIntervalMs?: number;
}

export function runMixedVersionIpcMatrix(
  input: MixedVersionIpcInput,
  dependencies?: MixedVersionIpcDependencies,
): Promise<Array<{ id: string; sparkHome: string; runtimeDir: string }>>;

export interface MixedVersionHubMigrationInput {
  baselineHub: string;
  baselineHubListArgs: string[];
  candidateHub: string;
  temporaryRoot: string;
  baseEnv?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function runMixedVersionHubMigrationMatrix(
  input: MixedVersionHubMigrationInput,
  dependencies?: {
    runHub?: (
      command: string,
      args: string[],
      options: MigrationCommandOptions,
    ) => CommandResult | Promise<CommandResult>;
  },
): Promise<{ databasePath: string }>;
