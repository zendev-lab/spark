import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";

import { cueShellProcessEnvironment } from "./executable-environment.ts";
import { CueError } from "./wire/types.ts";

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
const PROCESS_OUTPUT_LIMIT = 32 * 1024;

export type CueCommandInstallationStatus =
  | "aggregate"
  | "legacy-direct"
  | "foreign"
  | "incomplete-installation"
  | "missing";

export interface CueCommandSpec {
  command: string;
  args: string[];
}

export interface CueCommandContract {
  status: "aggregate" | "legacy-direct";
  version: string;
  client: CueCommandSpec;
  daemon: CueCommandSpec;
}

export interface CueProcessResult {
  command: string;
  args: string[];
  executablePath?: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: { code?: string; message: string };
}

export interface CueCommandInspection {
  status: CueCommandInstallationStatus;
  contract?: CueCommandContract;
  probes: CueProcessResult[];
  message: string;
}

export interface CueCommandRunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type CueCommandRunner = (
  spec: CueCommandSpec,
  options?: CueCommandRunOptions,
) => Promise<CueProcessResult>;

export interface CueCommandInspectionOptions extends CueCommandRunOptions {
  runner?: CueCommandRunner;
}

interface VersionProbe {
  result: CueProcessResult;
  version?: string;
  identity: "cue-shell" | "foreign" | "missing" | "failed";
}

export async function inspectCueCommandContract(
  options: CueCommandInspectionOptions = {},
): Promise<CueCommandInspection> {
  const runner = options.runner ?? runCueCommand;
  const probeOptions = { env: options.env, timeoutMs: options.timeoutMs };
  const probes: CueProcessResult[] = [];
  const aggregateRoot = await probeVersion(
    runner,
    { command: "cue", args: ["--version"] },
    /^cue\s+(\S+)$/u,
    probeOptions,
  );
  probes.push(aggregateRoot.result);

  if (aggregateRoot.identity === "cue-shell") {
    const aggregateClient = await probeVersion(
      runner,
      { command: "cue", args: ["client", "--version"] },
      /^cue-client\s+(\S+)$/u,
      probeOptions,
    );
    const aggregateDaemon = await probeVersion(
      runner,
      { command: "cue", args: ["daemon", "--version"] },
      /^Version:\s+(\S+)$/u,
      probeOptions,
    );
    probes.push(aggregateClient.result, aggregateDaemon.result);
    const aggregateVersion = aggregateRoot.version;
    if (
      aggregateVersion !== undefined &&
      aggregateClient.identity === "cue-shell" &&
      aggregateDaemon.identity === "cue-shell" &&
      aggregateVersion === aggregateClient.version &&
      aggregateVersion === aggregateDaemon.version
    ) {
      const contract: CueCommandContract = {
        status: "aggregate",
        version: aggregateVersion,
        client: { command: "cue", args: ["client"] },
        daemon: { command: "cue", args: ["daemon"] },
      };
      return {
        status: "aggregate",
        contract,
        probes,
        message: `cue-shell aggregate command is ready (version ${contract.version})`,
      };
    }
    return {
      status: "incomplete-installation",
      probes,
      message: renderIncompleteInstallation(probes, "cue-shell aggregate namespaces disagree"),
    };
  }

  const directClient = await probeVersion(
    runner,
    { command: "cue-client", args: ["--version"] },
    /^cue-client\s+(\S+)$/u,
    probeOptions,
  );
  const directDaemon = await probeVersion(
    runner,
    { command: "cued", args: ["--version"] },
    /^Version:\s+(\S+)$/u,
    probeOptions,
  );
  probes.push(directClient.result, directDaemon.result);
  const directVersion = directClient.version;
  if (
    directVersion !== undefined &&
    directClient.identity === "cue-shell" &&
    directDaemon.identity === "cue-shell" &&
    directVersion === directDaemon.version
  ) {
    const contract: CueCommandContract = {
      status: "legacy-direct",
      version: directVersion,
      client: { command: "cue-client", args: [] },
      daemon: { command: "cued", args: [] },
    };
    const reason =
      aggregateRoot.identity === "foreign"
        ? `using cue-shell legacy commands because ${describeProbe(aggregateRoot.result)} is not the cue-shell aggregate CLI`
        : `using cue-shell legacy commands (version ${contract.version}); reinstall cue-shell to restore the aggregate CLI`;
    return {
      status: "legacy-direct",
      contract,
      probes,
      message: reason,
    };
  }

  const anyCueShell = [directClient, directDaemon].some((probe) => probe.identity === "cue-shell");
  if (aggregateRoot.identity === "foreign") {
    return {
      status: "foreign",
      probes,
      message: renderForeignInstallation(probes),
    };
  }
  if (anyCueShell || [directClient, directDaemon].some((probe) => probe.identity === "failed")) {
    return {
      status: "incomplete-installation",
      probes,
      message: renderIncompleteInstallation(probes, "cue-shell direct commands disagree"),
    };
  }
  return {
    status: "missing",
    probes,
    message: renderMissingInstallation(probes),
  };
}

export async function requireCueCommandContract(
  options: CueCommandInspectionOptions = {},
): Promise<CueCommandContract> {
  const inspection = await inspectCueCommandContract(options);
  if (inspection.contract) return inspection.contract;
  let code = "CUE_INSTALLATION_INCOMPLETE";
  if (inspection.status === "missing") code = "CUE_INSTALLATION_MISSING";
  else if (inspection.status === "foreign") code = "CUE_COMMAND_FOREIGN";
  throw new CueError(code, inspection.message);
}

export async function runCueCommand(
  spec: CueCommandSpec,
  options: CueCommandRunOptions = {},
): Promise<CueProcessResult> {
  const env = cueShellProcessEnvironment(options.env);
  const executablePath = resolveExecutablePath(spec.command, env);
  return new Promise((resolveResult) => {
    const child = spawn(spec.command, spec.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settle = (result: CueProcessResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveResult(result);
    };
    child.stdout.on("data", (chunk: Buffer) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => appendBounded(stderr, chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      settle({
        command: spec.command,
        args: spec.args,
        ...(executablePath ? { executablePath } : {}),
        code: null,
        signal: null,
        stdout: joined(stdout),
        stderr: joined(stderr),
        error: { ...(error.code ? { code: error.code } : {}), message: error.message },
      }),
    );
    child.on("close", (code, signal) =>
      settle({
        command: spec.command,
        args: spec.args,
        ...(executablePath ? { executablePath } : {}),
        code,
        signal,
        stdout: joined(stdout),
        stderr: joined(stderr),
      }),
    );
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        settle({
          command: spec.command,
          args: spec.args,
          ...(executablePath ? { executablePath } : {}),
          code: null,
          signal: "SIGTERM",
          stdout: joined(stdout),
          stderr: joined(stderr),
          error: { message: `timed out after ${timeoutMs}ms` },
        });
      }, timeoutMs);
      timeout.unref?.();
    }
  });
}

export function renderCueCommandFailure(result: CueProcessResult): string {
  const command = [result.command, ...result.args].join(" ");
  let status = `exited with code ${result.code}`;
  if (result.error) status = result.error.message;
  else if (result.signal) status = `terminated by signal ${result.signal}`;
  const lines = [`${command}: ${status}`];
  if (result.executablePath) lines.push(`executable: ${result.executablePath}`);
  lines.push(result.stderr ? `stderr:\n${result.stderr}` : "stderr: <empty>");
  lines.push(result.stdout ? `stdout:\n${result.stdout}` : "stdout: <empty>");
  return lines.join("\n");
}

async function probeVersion(
  runner: CueCommandRunner,
  spec: CueCommandSpec,
  pattern: RegExp,
  options: CueCommandRunOptions,
): Promise<VersionProbe> {
  const result = await runner(spec, options);
  if (result.error?.code === "ENOENT") return { result, identity: "missing" };
  if (result.error || result.code !== 0) return { result, identity: "failed" };
  const match = pattern.exec(result.stdout.trim());
  return match
    ? { result, version: match[1], identity: "cue-shell" }
    : { result, identity: "foreign" };
}

function renderMissingInstallation(probes: CueProcessResult[]): string {
  return [
    "cue-shell is required for command execution but was not found.",
    renderProbeLocations(probes),
    "Install it with:",
    "  uv tool install cue-shell",
  ].join("\n");
}

function renderIncompleteInstallation(probes: CueProcessResult[], reason: string): string {
  return [
    `cue-shell installation is incomplete: ${reason}.`,
    renderProbeLocations(probes),
    "Repair the installation through its original owner. For uv installs:",
    "  uv tool install --reinstall cue-shell",
  ].join("\n");
}

function renderForeignInstallation(probes: CueProcessResult[]): string {
  const cue = probes[0];
  if (!cue) return renderMissingInstallation(probes);
  return [
    "the `cue` command on PATH is not the cue-shell aggregate CLI, and no complete legacy cue-shell command set was found.",
    `Found: ${describeProbe(cue)}`,
    renderProbeLocations(probes),
    "Install cue-shell in a user bin directory that does not overwrite the existing command:",
    "  uv tool install cue-shell",
  ].join("\n");
}

function renderProbeLocations(probes: CueProcessResult[]): string {
  return ["Probed commands:", ...probes.map((probe) => `  ${describeProbe(probe)}`)].join("\n");
}

function describeProbe(probe: CueProcessResult): string {
  const command = [probe.command, ...probe.args].join(" ");
  const location = probe.executablePath ?? "<not found on PATH>";
  const output = probe.stdout.trim() || probe.stderr.trim();
  const detail = probe.error?.message ?? output;
  return `${command} -> ${location}${detail ? ` (${firstLine(detail)})` : ""}`;
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0]?.slice(0, 240) ?? "";
}

function resolveExecutablePath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const candidates: string[] = [];
  if (isAbsolute(command)) candidates.push(command);
  else {
    for (const directory of (env.PATH ?? "").split(delimiter)) {
      if (directory) candidates.push(resolve(directory, command));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for the first executable PATH entry.
    }
  }
  return undefined;
}

function appendBounded(chunks: Buffer[], chunk: Buffer): void {
  chunks.push(Buffer.from(chunk));
  let total = chunks.reduce((sum, item) => sum + item.length, 0);
  while (total > PROCESS_OUTPUT_LIMIT && chunks.length > 0) {
    const first = chunks[0];
    if (!first) break;
    const extra = total - PROCESS_OUTPUT_LIMIT;
    if (first.length <= extra) {
      chunks.shift();
      total -= first.length;
    } else {
      chunks[0] = first.subarray(extra);
      total -= extra;
    }
  }
}

function joined(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8").trim();
}
