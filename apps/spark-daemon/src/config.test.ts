import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import {
  DEFAULT_SPARK_DAEMON_INVOCATION_CONCURRENCY,
  readSparkDaemonConfig,
  resolveSparkDaemonInvocationConcurrency,
  writeSparkDaemonConfig,
} from "./config.js";

describe("Spark daemon config", () => {
  it("round-trips daemon TOML with private file permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-config-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
        configFile: join(root, "config", "daemon.toml"),
      },
    });

    try {
      writeSparkDaemonConfig(paths, {
        installationId: "install-test",
        displayName: "Test Daemon",
        invocationConcurrency: 8,
        serverUrl: "http://127.0.0.1:5173",
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeToken: "spark_rt_test_token_00000000000000000000000000000000",
        runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
        refreshToken: "spark_rt_refresh_test_0000000000000000000000000000",
        refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
        webSocketUrl: "ws://127.0.0.1:5173/api/v1/runtime/runtimes/rt/ws",
      });

      expect(readSparkDaemonConfig(paths)).toMatchObject({
        installationId: "install-test",
        displayName: "Test Daemon",
        invocationConcurrency: 8,
        runtimeId: "rt_11111111111141111111111111111111",
        runtimeTokenExpiresAt: "2026-05-25T01:00:00.000Z",
        refreshTokenExpiresAt: "2026-06-24T00:00:00.000Z",
      });
      expect(statSync(paths.configFile).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("defaults root invocation concurrency to four and rejects invalid persisted values", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-config-"));
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: { configFile: join(root, "config", "daemon.toml") },
    });

    try {
      expect(resolveSparkDaemonInvocationConcurrency(readSparkDaemonConfig(paths))).toBe(
        DEFAULT_SPARK_DAEMON_INVOCATION_CONCURRENCY,
      );
      writeSparkDaemonConfig(paths, {
        installationId: "install-test",
        displayName: "Test daemon",
        invocationConcurrency: 65,
      });
      expect.unreachable("expected an out-of-range concurrency to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect(String(error)).toContain("between 1 and 64");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const malformedRoot = mkdtempSync(join(tmpdir(), "spark-daemon-config-"));
    const malformedPaths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: malformedRoot },
      overrides: { configFile: join(malformedRoot, "daemon.toml") },
    });
    try {
      writeFileSync(
        malformedPaths.configFile,
        'installationId = "install-test"\ndisplayName = "Test daemon"\ninvocationConcurrency = "8"\n',
      );
      expect(() => readSparkDaemonConfig(malformedPaths)).toThrow(/between 1 and 64/u);
    } finally {
      rmSync(malformedRoot, { recursive: true, force: true });
    }
  });
});
