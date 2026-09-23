import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";

const vite = vi.hoisted(() => ({ createServer: vi.fn() }));

vi.mock("vite", () => ({ createServer: vite.createServer }));

import { startSparkWebDevelopmentServer } from "./vite-server.ts";

test("source web keeps the app cwd for deferred SvelteKit module loading", async () => {
  const appDir = await mkdtemp(join(tmpdir(), "spark-web-vite-root-"));
  const resolvedAppDir = await realpath(appDir);
  const launchCwd = process.cwd();
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
  } finally {
    process.chdir(launchCwd);
    await rm(appDir, { recursive: true, force: true });
  }
});

test("source web restores launch cwd when startup fails", async () => {
  const appDir = await mkdtemp(join(tmpdir(), "spark-web-vite-failure-"));
  const launchCwd = process.cwd();
  vite.createServer.mockRejectedValueOnce(new Error("startup failed"));
  try {
    await assert.rejects(
      startSparkWebDevelopmentServer({ appDir, host: "127.0.0.1", port: 4310, hmr: false }),
      /startup failed/,
    );
    assert.equal(process.cwd(), launchCwd);
  } finally {
    process.chdir(launchCwd);
    await rm(appDir, { recursive: true, force: true });
  }
});
