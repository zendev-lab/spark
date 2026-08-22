import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ConfinedArgv,
  RunnerFailureRule,
  SandboxPolicy,
  SandboxProvider,
} from "@deepseek-ai/dsh-sandbox";
import type { SpawnAdapterHandle } from "@zendev-lab/spark-cue";

const MAX_MESSAGE_BYTES = 1024 * 1024;

interface StepId {
  execution: number;
  index: number;
}

type SpawnResult =
  | { type: "exited"; code: number }
  | { type: "signaled"; signal: number }
  | { type: "spawn_error"; message: string };

type SpawnAdapterRequest =
  | {
      type: "prepare";
      token: string;
      execution_id: number;
      step_id: StepId;
      segment_index: number;
      argv: string[];
      cwd: string;
    }
  | {
      type: "settle";
      token: string;
      execution_id: number;
      step_id: StepId;
      segment_index: number;
      result: SpawnResult;
      diagnostic_tail: string;
      diagnostic_truncated: boolean;
    };

interface PreparedSegment {
  confined: ConfinedArgv;
  settled: boolean;
}

export interface SandboxSpawnFact {
  executionId: number;
  stepId: StepId;
  segmentIndex: number;
  mode: SandboxPolicy["mode"];
  enforcement: ConfinedArgv["enforcement"];
  denied: boolean;
  runnerFailure: boolean;
  diagnosticTruncated: boolean;
}

export interface SpawnAdapterBroker {
  readonly handle: SpawnAdapterHandle;
  facts(): SandboxSpawnFact[];
  close(): Promise<void>;
}

export async function startSpawnAdapterBroker(options: {
  sandbox: SandboxProvider;
  policy: SandboxPolicy;
  runtimeDir?: string;
}): Promise<SpawnAdapterBroker> {
  const adapterDir = options.runtimeDir ?? defaultAdapterDir();
  await ensurePrivateDirectory(adapterDir);
  const endpoint = join(adapterDir, `dsh-${process.pid}-${randomBytes(6).toString("hex")}.sock`);
  const token = randomBytes(32).toString("base64url");
  const prepared = new Map<string, PreparedSegment>();
  const recordedFacts: SandboxSpawnFact[] = [];
  let closed = false;

  const server = net.createServer((socket) => {
    handleConnection(socket, async (request) => {
      if (request.token !== token) return { type: "rejected", message: "invalid adapter token" };
      const key = segmentKey(request);
      if (request.type === "prepare") {
        if (!isPrepareRequest(request)) {
          return { type: "rejected", message: "invalid prepare request" };
        }
        if (prepared.has(key)) {
          return { type: "rejected", message: "spawn segment was prepared more than once" };
        }
        try {
          const confined = options.sandbox.confine(request.argv, options.policy);
          if (confined.argv.length === 0 || !confined.argv[0]) {
            return { type: "rejected", message: "sandbox returned an empty argv" };
          }
          prepared.set(key, { confined, settled: false });
          return { type: "prepared", argv: confined.argv };
        } catch (error) {
          return {
            type: "rejected",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const segment = prepared.get(key);
      if (!segment || segment.settled) {
        return { type: "infrastructure_failure", message: "spawn segment has no active lease" };
      }
      segment.settled = true;
      const runnerFailure = isRunnerFailure(
        request.result,
        request.diagnostic_tail,
        segment.confined.runnerFailureRules,
      );
      const denied =
        !runnerFailure &&
        matchesAnyDiagnostic(request.diagnostic_tail, segment.confined.denialSignatures);
      recordedFacts.push({
        executionId: request.execution_id,
        stepId: request.step_id,
        segmentIndex: request.segment_index,
        mode: options.policy.mode,
        enforcement: segment.confined.enforcement,
        denied,
        runnerFailure,
        diagnosticTruncated: request.diagnostic_truncated,
      });
      if (runnerFailure || request.result.type === "spawn_error") {
        return {
          type: "infrastructure_failure",
          message:
            request.result.type === "spawn_error"
              ? `sandbox runner could not spawn: ${request.result.message}`
              : "sandbox runner failed before the command executed",
        };
      }
      return { type: "settled" };
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  await chmod(endpoint, 0o600);

  return {
    handle: { endpoint, token },
    facts: () => recordedFacts.map((fact) => ({ ...fact, stepId: { ...fact.stepId } })),
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        const metadata = await lstat(endpoint);
        if (!metadata.isSocket())
          throw new Error(`refusing to unlink non-socket adapter path ${endpoint}`);
        await unlink(endpoint);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function defaultAdapterDir(): string {
  const runtimeRoot = process.env.XDG_RUNTIME_DIR?.trim() || tmpdir();
  return join(runtimeRoot, "cue", "adapters");
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error(`Cue adapter parent is not a directory: ${parent}`);
  }
  assertOwnedByCurrentUser(parent, parentMetadata.uid);
  await chmod(parent, 0o700);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Cue adapter directory is not a private directory: ${path}`);
  }
  assertOwnedByCurrentUser(path, metadata.uid);
  await chmod(path, 0o700);
}

function assertOwnedByCurrentUser(path: string, uid: number): void {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && uid !== currentUid) {
    throw new Error(`Cue adapter path is not owned by the current user: ${path}`);
  }
}

function segmentKey(request: SpawnAdapterRequest): string {
  return `${request.execution_id}/${request.step_id.execution}/${request.step_id.index}/${request.segment_index}`;
}

function isPrepareRequest(request: Extract<SpawnAdapterRequest, { type: "prepare" }>): boolean {
  return (
    Number.isSafeInteger(request.execution_id) &&
    request.execution_id > 0 &&
    request.step_id.execution === request.execution_id &&
    Number.isSafeInteger(request.step_id.index) &&
    request.step_id.index > 0 &&
    Number.isSafeInteger(request.segment_index) &&
    request.segment_index >= 0 &&
    request.argv.length > 0 &&
    request.argv.every((word) => typeof word === "string") &&
    typeof request.cwd === "string"
  );
}

function isRunnerFailure(
  result: SpawnResult,
  diagnostic: string,
  rules: readonly RunnerFailureRule[],
): boolean {
  if (result.type === "spawn_error") return true;
  if (result.type === "exited" && result.code === 0) return false;
  const lines = diagnostic.split(/\r?\n/u).map((line) => line.toLowerCase());
  return rules.some((rule) => {
    if (
      result.type === "exited" &&
      rule.allowedExitCodes !== undefined &&
      !rule.allowedExitCodes.includes(result.code)
    ) {
      return false;
    }
    if (result.type === "signaled" && rule.allowedExitCodes !== undefined) return false;
    const informational = new Set(
      (rule.informationalLines ?? []).map((line) => line.toLowerCase()),
    );
    return lines
      .filter((line) => !informational.has(line))
      .some((line) =>
        rule.fatalSignatures.some((signature) => line.includes(signature.toLowerCase())),
      );
  });
}

function matchesAnyDiagnostic(diagnostic: string, signatures: readonly string[]): boolean {
  const normalized = diagnostic.toLowerCase();
  return signatures.some((signature) => normalized.includes(signature.toLowerCase()));
}

function handleConnection(
  socket: Socket,
  respond: (request: SpawnAdapterRequest) => Promise<Record<string, unknown>>,
): void {
  let buffer = Buffer.alloc(0);
  let handled = false;
  socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length < 4) return;
    const length = buffer.readUInt32BE(0);
    if (length > MAX_MESSAGE_BYTES) {
      handled = true;
      socket.destroy(new Error("spawn adapter request is too large"));
      return;
    }
    if (buffer.length < length + 4) return;
    handled = true;
    void (async () => {
      try {
        const request = parseSpawnAdapterRequest(
          JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")),
        );
        const response = await respond(request);
        const body = Buffer.from(JSON.stringify(response), "utf8");
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        socket.end(Buffer.concat([header, body]));
      } catch (error) {
        const body = Buffer.from(
          JSON.stringify({
            type: "infrastructure_failure",
            message: error instanceof Error ? error.message : String(error),
          }),
          "utf8",
        );
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        socket.end(Buffer.concat([header, body]));
      }
    })();
  });
}

function parseSpawnAdapterRequest(value: unknown): SpawnAdapterRequest {
  const record = exactRecord(value, "spawn adapter request");
  if (record.type === "prepare") {
    exactKeys(record, ["type", "token", "execution_id", "step_id", "segment_index", "argv", "cwd"]);
    const request = {
      type: "prepare" as const,
      token: requiredString(record.token, "token"),
      execution_id: requiredPositiveInteger(record.execution_id, "execution_id"),
      step_id: parseStepId(record.step_id),
      segment_index: requiredNonNegativeInteger(record.segment_index, "segment_index"),
      argv: requiredStringArray(record.argv, "argv"),
      cwd: requiredString(record.cwd, "cwd"),
    };
    if (!isPrepareRequest(request)) throw new Error("invalid prepare request");
    return request;
  }
  if (record.type === "settle") {
    exactKeys(record, [
      "type",
      "token",
      "execution_id",
      "step_id",
      "segment_index",
      "result",
      "diagnostic_tail",
      "diagnostic_truncated",
    ]);
    const executionId = requiredPositiveInteger(record.execution_id, "execution_id");
    const stepId = parseStepId(record.step_id);
    if (stepId.execution !== executionId) {
      throw new Error("step_id.execution must match execution_id");
    }
    if (typeof record.diagnostic_truncated !== "boolean") {
      throw new Error("diagnostic_truncated must be a boolean");
    }
    return {
      type: "settle",
      token: requiredString(record.token, "token"),
      execution_id: executionId,
      step_id: stepId,
      segment_index: requiredNonNegativeInteger(record.segment_index, "segment_index"),
      result: parseSpawnResult(record.result),
      diagnostic_tail: requiredString(record.diagnostic_tail, "diagnostic_tail"),
      diagnostic_truncated: record.diagnostic_truncated,
    };
  }
  throw new Error("spawn adapter request type must be prepare or settle");
}

function parseStepId(value: unknown): StepId {
  const record = exactRecord(value, "step_id");
  exactKeys(record, ["execution", "index"]);
  return {
    execution: requiredPositiveInteger(record.execution, "step_id.execution"),
    index: requiredPositiveInteger(record.index, "step_id.index"),
  };
}

function parseSpawnResult(value: unknown): SpawnResult {
  const record = exactRecord(value, "result");
  if (record.type === "exited") {
    exactKeys(record, ["type", "code"]);
    return { type: "exited", code: requiredNonNegativeInteger(record.code, "result.code") };
  }
  if (record.type === "signaled") {
    exactKeys(record, ["type", "signal"]);
    return { type: "signaled", signal: requiredPositiveInteger(record.signal, "result.signal") };
  }
  if (record.type === "spawn_error") {
    exactKeys(record, ["type", "message"]);
    return { type: "spawn_error", message: requiredString(record.message, "result.message") };
  }
  throw new Error("result.type must be exited, signaled, or spawn_error");
}

function exactRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown spawn adapter field: ${unknown}`);
  const missing = keys.find((key) => !(key in record));
  if (missing) throw new Error(`missing spawn adapter field: ${missing}`);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function requiredPositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value as number;
}

function requiredNonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value as number;
}

function requiredStringArray(value: unknown, path: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return value;
}
