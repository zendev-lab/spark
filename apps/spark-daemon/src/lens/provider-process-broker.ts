import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  decideProviderTrust,
  type ProviderLaunchSpec,
  type ProviderTrustGrant,
} from "@zendev-lab/spark-lens";

import { DaemonLensStateStore, type LensProviderProcessRecord } from "./state-store.ts";

const execFileAsync = promisify(execFile);
const PROVIDER_WRAPPER_MARKER = "SPARK_LENS_PROVIDER_WRAPPER";
const PROVIDER_WRAPPER_SOURCE = `
const { spawn } = require("node:child_process");
const marker = process.argv[1];
if (!marker || !marker.startsWith("${PROVIDER_WRAPPER_MARKER}:")) process.exit(64);
const executable = process.argv[2];
const args = JSON.parse(process.argv[3]);
const child = spawn(executable, args, { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
`;

export interface ProviderProcessIdentity {
  providerId: string;
  worktreeRoot: string;
  projectRoot: string;
  configDigest: string;
}

export interface ManagedProviderProcess {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(): Promise<void>;
}

type ProviderProcessLauncher = (
  launch: ProviderLaunchSpec,
  marker: string,
) => Promise<ManagedProviderProcess>;

export interface ProviderProcessLease {
  processKey: string;
  process: ManagedProviderProcess;
  release(): void;
}

interface DaemonLensProcessBrokerOptions {
  stateStore: DaemonLensStateStore;
  daemonInstanceId?: string;
  launcher?: ProviderProcessLauncher;
  heartbeatMs?: number;
  cooldownMs?: number;
  inspectOwnedProcess?: (pid: number, marker: string) => Promise<boolean>;
  terminateOrphan?: (pid: number) => Promise<void>;
}

interface ProcessEntry {
  processKey: string;
  process: ManagedProviderProcess;
  refs: number;
  heartbeat: NodeJS.Timeout;
  stopping: boolean;
}

export class DaemonLensProcessBroker {
  readonly #stateStore: DaemonLensStateStore;
  readonly #daemonInstanceId: string;
  readonly #launcher: ProviderProcessLauncher;
  readonly #heartbeatMs: number;
  readonly #cooldownMs: number;
  readonly #inspectOwnedProcess: (pid: number, marker: string) => Promise<boolean>;
  readonly #terminateOrphan: (pid: number) => Promise<void>;
  readonly #entries = new Map<string, Promise<ProcessEntry>>();
  readonly #cooldowns = new Map<string, number>();

  constructor(options: DaemonLensProcessBrokerOptions) {
    this.#stateStore = options.stateStore;
    this.#daemonInstanceId = options.daemonInstanceId ?? randomUUID();
    this.#launcher = options.launcher ?? launchProviderProcess;
    this.#heartbeatMs = options.heartbeatMs ?? 5_000;
    this.#cooldownMs = options.cooldownMs ?? 5_000;
    this.#inspectOwnedProcess = options.inspectOwnedProcess ?? inspectOwnedProviderProcess;
    this.#terminateOrphan = options.terminateOrphan ?? terminateProcessGroup;
  }

  async recoverOrphans(): Promise<number> {
    let recovered = 0;
    for (const record of this.#stateStore.listProviderProcesses("running")) {
      if (record.daemonInstanceId === this.#daemonInstanceId) continue;
      const owned = await this.#inspectOwnedProcess(record.pid, record.processMarker);
      if (owned) {
        await this.#terminateOrphan(record.pid);
        recovered += 1;
      }
      const now = new Date().toISOString();
      this.#stateStore.updateProviderProcess(record.processKey, {
        status: owned ? "recovered" : "crashed",
        lastHeartbeatAt: now,
        exitedAt: now,
      });
    }
    return recovered;
  }

  async acquire(input: {
    identity: ProviderProcessIdentity;
    launch: ProviderLaunchSpec;
    trustGrant?: ProviderTrustGrant;
  }): Promise<ProviderProcessLease> {
    const trust = decideProviderTrust(input.launch, input.trustGrant);
    if (!trust.trusted) {
      throw new Error(`Lens provider launch denied (${trust.reason}): ${input.launch.providerId}`);
    }
    const processKey = providerProcessKey(input.identity);
    const cooldownUntil = this.#cooldowns.get(processKey) ?? 0;
    if (cooldownUntil > Date.now()) {
      throw new Error(`Lens provider is cooling down: ${input.identity.providerId}`);
    }

    let opening = this.#entries.get(processKey);
    if (!opening) {
      opening = this.#open(processKey, input.identity, input.launch);
      this.#entries.set(processKey, opening);
    }
    let entry: ProcessEntry;
    try {
      entry = await opening;
    } catch (error) {
      if (this.#entries.get(processKey) === opening) this.#entries.delete(processKey);
      this.#cooldowns.set(processKey, Date.now() + this.#cooldownMs);
      throw error;
    }
    entry.refs += 1;
    let released = false;
    return {
      processKey,
      process: entry.process,
      release() {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
      },
    };
  }

  activeProcessCount(): number {
    return this.#entries.size;
  }

  async close(): Promise<void> {
    const openings = [...this.#entries.values()];
    this.#entries.clear();
    const settled = await Promise.allSettled(openings);
    await Promise.allSettled(
      settled
        .filter(
          (result): result is PromiseFulfilledResult<ProcessEntry> => result.status === "fulfilled",
        )
        .map(async ({ value: entry }) => {
          entry.stopping = true;
          clearInterval(entry.heartbeat);
          await entry.process.terminate();
          const now = new Date().toISOString();
          this.#stateStore.updateProviderProcess(entry.processKey, {
            status: "stopped",
            lastHeartbeatAt: now,
            exitedAt: now,
          });
        }),
    );
  }

  async #open(
    processKey: string,
    identity: ProviderProcessIdentity,
    launch: ProviderLaunchSpec,
  ): Promise<ProcessEntry> {
    const marker = `${PROVIDER_WRAPPER_MARKER}:${randomUUID()}`;
    const process = await this.#launcher(launch, marker);
    const now = new Date().toISOString();
    const record: LensProviderProcessRecord = {
      processKey,
      providerId: identity.providerId,
      worktreeRoot: identity.worktreeRoot,
      projectRoot: identity.projectRoot,
      configDigest: identity.configDigest,
      executableDigest: launch.executableDigest,
      daemonInstanceId: this.#daemonInstanceId,
      processMarker: marker,
      pid: process.pid,
      status: "running",
      startedAt: now,
      lastHeartbeatAt: now,
    };
    this.#stateStore.saveProviderProcess(record);
    const heartbeat = setInterval(() => {
      this.#stateStore.updateProviderProcess(processKey, {
        lastHeartbeatAt: new Date().toISOString(),
      });
    }, this.#heartbeatMs);
    heartbeat.unref();
    const entry: ProcessEntry = {
      processKey,
      process,
      refs: 0,
      heartbeat,
      stopping: false,
    };
    void process.exited.then(() => {
      clearInterval(heartbeat);
      if (this.#entries.get(processKey)) this.#entries.delete(processKey);
      if (!entry.stopping) this.#cooldowns.set(processKey, Date.now() + this.#cooldownMs);
      const exitedAt = new Date().toISOString();
      this.#stateStore.updateProviderProcess(processKey, {
        status: entry.stopping ? "stopped" : "crashed",
        lastHeartbeatAt: exitedAt,
        exitedAt,
      });
    });
    return entry;
  }
}

export function providerProcessKey(identity: ProviderProcessIdentity): string {
  return createHash("sha256")
    .update(
      [
        identity.providerId,
        identity.worktreeRoot,
        identity.projectRoot,
        identity.configDigest,
      ].join("\0"),
    )
    .digest("hex");
}

async function launchProviderProcess(
  launch: ProviderLaunchSpec,
  marker: string,
): Promise<ManagedProviderProcess> {
  const child = spawn(
    process.execPath,
    ["-e", PROVIDER_WRAPPER_SOURCE, marker, launch.executable, JSON.stringify(launch.args)],
    {
      cwd: launch.cwd,
      detached: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (!child.pid) throw new Error(`failed to start Lens provider ${launch.providerId}`);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const settle = (value: { code: number | null; signal: NodeJS.Signals | null }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", () => settle({ code: null, signal: null }));
    child.once("exit", (code, signal) => settle({ code, signal }));
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
    async terminate() {
      await terminateChild(child.pid!, exited);
    },
  };
}

async function terminateChild(pid: number, exited: Promise<unknown>): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  const stopped = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
  ]);
  if (stopped) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process exited between the timeout and the signal.
  }
}

async function inspectOwnedProviderProcess(pid: number, marker: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    return stdout.includes(PROVIDER_WRAPPER_MARKER) && stdout.includes(marker);
  } catch {
    return false;
  }
}

async function terminateProcessGroup(pid: number): Promise<void> {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}