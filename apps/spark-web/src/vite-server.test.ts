import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

const vite = vi.hoisted(() => ({ createServer: vi.fn() }));

vi.mock("vite", () => ({ createServer: vite.createServer }));

import { startSparkWebDevelopmentServer } from "./vite-server.ts";
import {
  sparkWebLaunchDirectory,
  SPARK_WEB_LAUNCH_CWD_ENV,
} from "./lib/server/launch-directory.ts";

test("source web preserves its launch context while keeping SvelteKit in its app directory", async () => {
  const appDir = await mkdtemp(join(tmpdir(), "spark-web-vite-root-"));
  const resolvedAppDir = await realpath(appDir);
  const launchCwd = process.cwd();
  const previousLaunchCwd = process.env[SPARK_WEB_LAUNCH_CWD_ENV];
  let createCwd: string | undefined;
  let listenCwd: string | undefined;
  vite.createServer.mockImplementationOnce(async () => {
    createCwd = process.cwd();
    return {
      listen: async () => {
        listenCwd = process.cwd();
      },
    };
  });

  try {
    await startSparkWebDevelopmentServer({ appDir, host: "127.0.0.1", port: 4310, hmr: false });
    assert.equal(createCwd, resolvedAppDir);
    assert.equal(listenCwd, resolvedAppDir);
    assert.equal(process.cwd(), resolvedAppDir);
    assert.equal(sparkWebLaunchDirectory(), launchCwd);
  } finally {
    process.chdir(launchCwd);
    if (previousLaunchCwd === undefined) delete process.env[SPARK_WEB_LAUNCH_CWD_ENV];
    else process.env[SPARK_WEB_LAUNCH_CWD_ENV] = previousLaunchCwd;
    await rm(appDir, { recursive: true, force: true });
  }
});

test("failed development startup restores the caller's directory and launch context", async () => {
  const launchCwd = process.cwd();
  const previousLaunchCwd = process.env[SPARK_WEB_LAUNCH_CWD_ENV];
  const appDir = await mkdtemp(join(tmpdir(), "spark-web-vite-failure-"));
  const failure = new Error("address in use");
  vite.createServer.mockResolvedValueOnce({
    listen: async () => {
      throw failure;
    },
  });
  try {
    await assert.rejects(
      startSparkWebDevelopmentServer({ appDir, host: "127.0.0.1", port: 4310, hmr: true }),
      (error: unknown) => error === failure,
    );
    assert.equal(process.cwd(), launchCwd);
    assert.equal(process.env[SPARK_WEB_LAUNCH_CWD_ENV], previousLaunchCwd);
  } finally {
    process.chdir(launchCwd);
    await rm(appDir, { recursive: true, force: true });
  }
});
