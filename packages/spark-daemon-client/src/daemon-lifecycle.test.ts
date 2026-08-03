import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureSparkDaemonRunning, resolveSparkDaemonServiceCommand } from "./daemon-lifecycle.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Spark daemon lifecycle client", () => {
  it("does not start a service when daemon status is already reachable", async () => {
    const startService = vi.fn();

    await ensureSparkDaemonRunning({
      paths: { runtimeDir: "/tmp/runtime", logDir: "/tmp/log" },
      requestStatus: async () => ({ ready: true }),
      startService,
    });

    expect(startService).not.toHaveBeenCalled();
  });

  it("starts once and requires a real status response before returning", async () => {
    let attempts = 0;
    const startService = vi.fn();

    await ensureSparkDaemonRunning({
      paths: { runtimeDir: "/tmp/runtime", logDir: "/tmp/log" },
      serviceCommand: { command: "spark", args: ["daemon"] },
      requestStatus: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("not ready");
        return { ready: true };
      },
      startService,
      sleep: async () => undefined,
    });

    expect(startService).toHaveBeenCalledOnce();
    expect(startService).toHaveBeenCalledWith(
      { command: "spark", args: ["daemon"] },
      { runtimeDir: "/tmp/runtime", logDir: "/tmp/log" },
      expect.any(Object),
    );
    expect(attempts).toBe(3);
  });

  it("fails with the last status error after the startup deadline", async () => {
    let now = 0;

    await expect(
      ensureSparkDaemonRunning({
        paths: { runtimeDir: "/tmp/runtime", logDir: "/tmp/log" },
        serviceCommand: { command: "spark", args: ["daemon"] },
        requestStatus: async () => {
          throw new Error("socket unavailable");
        },
        startService: async () => undefined,
        startupTimeoutMs: 100,
        now: () => now,
        sleep: async (delayMs) => {
          now += delayMs;
        },
      }),
    ).rejects.toThrow("Spark daemon is not reachable after service start: socket unavailable");
  });

  it("prefers an explicit packaged entrypoint and validates source builds", () => {
    const packagedRoot = temporaryDirectory("spark-daemon-packaged-");
    const packagedEntrypoint = join(packagedRoot, "daemon.js");
    writeFileSync(packagedEntrypoint, "export {};\n", "utf8");
    expect(
      resolveSparkDaemonServiceCommand({
        env: { SPARK_DAEMON_ENTRYPOINT: packagedEntrypoint },
      }),
    ).toEqual({ command: process.execPath, args: [packagedEntrypoint] });

    const sourceRoot = temporaryDirectory("spark-daemon-source-");
    mkdirSync(join(sourceRoot, "dist"), { recursive: true });
    writeFileSync(join(sourceRoot, "package.json"), "{}\n", "utf8");
    writeFileSync(join(sourceRoot, "dist", "cli.js"), "export {};\n", "utf8");
    const buildSource = vi.fn(() => 0);
    expect(resolveSparkDaemonServiceCommand({ daemonAppDir: sourceRoot, buildSource })).toEqual({
      command: process.execPath,
      args: [join(sourceRoot, "dist", "cli.js")],
    });
    expect(buildSource).toHaveBeenCalledWith(sourceRoot, process.env);

    expect(() =>
      resolveSparkDaemonServiceCommand({
        daemonAppDir: sourceRoot,
        buildSource: () => 1,
      }),
    ).toThrow("Failed to build the Spark daemon service entrypoint.");
  });
});
