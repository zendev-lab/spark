import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, type IPty } from "@lydell/node-pty";

const DEFAULT_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;
const FIXTURE_PATH = resolve(import.meta.dirname, "spark-native-tui-direct-pty-fixture.ts");

export interface SparkNativeTuiDirectPtyReport {
  readonly event: string;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly isRaw: boolean;
  readonly columns?: number;
  readonly rows?: number;
  readonly message?: string;
}

export interface SparkNativeTuiDirectPtyExit {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface SparkNativeTuiDirectPtyHarness {
  readonly pid: number;
  output(): string;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  waitForOutput(expected: string | RegExp, timeoutMs?: number): Promise<string>;
  waitForOutputAfter(
    offset: number,
    expected: string | RegExp,
    timeoutMs?: number,
  ): Promise<string>;
  reports(): Promise<SparkNativeTuiDirectPtyReport[]>;
  waitForReport(
    predicate: (report: SparkNativeTuiDirectPtyReport) => boolean,
    timeoutMs?: number,
  ): Promise<SparkNativeTuiDirectPtyReport>;
  waitForExit(timeoutMs?: number): Promise<SparkNativeTuiDirectPtyExit>;
  dispose(): Promise<void>;
}

export interface CreateSparkNativeTuiDirectPtyHarnessOptions {
  readonly columns?: number;
  readonly rows?: number;
  readonly terminationTimeoutMs?: number;
  readonly scenario?: "navigation" | "queue";
  /** Test seam for proving timeout escalation; the fixture still exits on SIGKILL. */
  readonly ignoreHangup?: boolean;
}

export async function createSparkNativeTuiDirectPtyHarness(
  options: CreateSparkNativeTuiDirectPtyHarnessOptions = {},
): Promise<SparkNativeTuiDirectPtyHarness> {
  const scratchRoot = await mkdtemp(resolve(tmpdir(), "spark-tui-direct-pty-"));
  const reportPath = resolve(scratchRoot, "report.jsonl");
  let capturedOutput = "";
  let settledExit: SparkNativeTuiDirectPtyExit | undefined;
  let resolveExit: (exit: SparkNativeTuiDirectPtyExit) => void;
  const exitPromise = new Promise<SparkNativeTuiDirectPtyExit>((resolveExitPromise) => {
    resolveExit = resolveExitPromise;
  });
  let pty: IPty;
  try {
    pty = spawn(process.execPath, ["--experimental-strip-types", FIXTURE_PATH], {
      name: "xterm-256color",
      cols: options.columns ?? 80,
      rows: options.rows ?? 24,
      cwd: resolve(import.meta.dirname, "../../../.."),
      env: {
        ...process.env,
        NO_COLOR: "1",
        SPARK_HOME: resolve(scratchRoot, "spark-home"),
        SPARK_TUI_DIRECT_PTY_REPORT: reportPath,
        ...(options.scenario ? { SPARK_TUI_DIRECT_PTY_SCENARIO: options.scenario } : {}),
        ...(options.ignoreHangup ? { SPARK_TUI_DIRECT_PTY_IGNORE_SIGHUP: "1" } : {}),
        TERM: "xterm-256color",
        TERM_PROGRAM: "spark-direct-pty-test",
      },
    });
  } catch (error) {
    await rm(scratchRoot, { recursive: true, force: true });
    throw error;
  }

  const outputSubscription = pty.onData((data) => {
    capturedOutput += data;
  });
  const exitSubscription = pty.onExit((exit) => {
    settledExit = exit;
    resolveExit(exit);
  });

  const readReports = async (): Promise<SparkNativeTuiDirectPtyReport[]> => {
    try {
      const text = await readFile(reportPath, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SparkNativeTuiDirectPtyReport);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
  };

  const terminationTimeoutMs = options.terminationTimeoutMs ?? 2_000;
  let disposePromise: Promise<void> | undefined;
  const dispose = async (): Promise<void> => {
    let terminationError: unknown;
    try {
      if (!settledExit) {
        try {
          pty.kill();
        } catch (error) {
          if (!isMissingProcessError(error)) throw error;
        }
        try {
          await withTimeout(
            exitPromise,
            terminationTimeoutMs,
            () => "Timed out terminating direct PTY fixture",
          );
        } catch (error) {
          terminationError = error;
          try {
            pty.kill("SIGKILL");
          } catch (killError) {
            if (!isMissingProcessError(killError)) throw killError;
          }
          await withTimeout(
            exitPromise,
            terminationTimeoutMs,
            () => "Timed out confirming forced direct PTY fixture termination",
          );
        }
      }
    } finally {
      outputSubscription.dispose();
      exitSubscription.dispose();
      await rm(scratchRoot, { recursive: true, force: true });
    }
    if (terminationError) throw terminationError;
  };

  return {
    pid: pty.pid,
    output: () => capturedOutput,
    write: (data) => pty.write(data),
    resize: (columns, rows) => pty.resize(columns, rows),
    async waitForOutput(expected, timeoutMs = DEFAULT_TIMEOUT_MS) {
      await waitForOutputAfter(0, expected, timeoutMs, () => capturedOutput);
      return capturedOutput;
    },
    async waitForOutputAfter(offset, expected, timeoutMs = DEFAULT_TIMEOUT_MS) {
      await waitForOutputAfter(offset, expected, timeoutMs, () => capturedOutput);
      return capturedOutput.slice(offset);
    },
    reports: readReports,
    async waitForReport(predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
      let matching: SparkNativeTuiDirectPtyReport | undefined;
      await waitUntil(
        async () => {
          matching = (await readReports()).find(predicate);
          return matching !== undefined;
        },
        timeoutMs,
        () => `Timed out waiting for PTY lifecycle report. Output:\n${capturedOutput}`,
      );
      if (!matching) throw new Error("PTY lifecycle report matched without a captured value");
      return matching;
    },
    async waitForExit(timeoutMs = DEFAULT_TIMEOUT_MS) {
      return await withTimeout(
        exitPromise,
        timeoutMs,
        () => `Timed out waiting for PTY exit. Output:\n${capturedOutput}`,
      );
    },
    dispose() {
      disposePromise ??= dispose();
      return disposePromise;
    },
  };
}

async function waitForOutputAfter(
  offset: number,
  expected: string | RegExp,
  timeoutMs: number,
  readOutput: () => string,
): Promise<void> {
  await waitUntil(
    () => {
      const output = readOutput().slice(offset);
      if (typeof expected === "string") return output.includes(expected);
      expected.lastIndex = 0;
      return expected.test(output);
    },
    timeoutMs,
    () => `Timed out waiting for PTY output ${String(expected)}. Output:\n${readOutput()}`,
  );
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await predicate()) return;
    if (Date.now() >= deadline) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_INTERVAL_MS));
  }
  throw new Error(timeoutMessage());
}

async function withTimeout<T>(
  value: Promise<T>,
  timeoutMs: number,
  timeoutMessage: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage())), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isMissingProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
