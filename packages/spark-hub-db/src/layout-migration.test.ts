import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveLegacyCockpitPaths, resolveSparkPaths } from "@zendev-lab/spark-system";
import {
  HubLayoutMigrationConflictError,
  HubLayoutMigrationLockedError,
  migrateLegacyCockpitLayout,
} from "./layout-migration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Cockpit-to-Hub filesystem migration", () => {
  it("moves XDG config and app trees and renames the sqlite database exactly once", async () => {
    const { root, env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    const hub = resolveSparkPaths({ app: "hub", env, cwd: "/" });
    mkdirSync(legacy.dataDir, { recursive: true });
    mkdirSync(legacy.cacheDir, { recursive: true });
    mkdirSync(legacy.stateDir, { recursive: true });
    mkdirSync(legacy.logDir, { recursive: true });
    mkdirSync(legacy.runtimeDir, { recursive: true });
    mkdirSync(legacy.configDir, { recursive: true });
    writeFileSync(legacy.configFile, "listen = '127.0.0.1'\n");
    writeFileSync(legacy.databasePath, "legacy-db");
    writeFileSync(join(legacy.cacheDir, "cache-entry"), "cache");
    writeFileSync(join(legacy.stateDir, "state-entry"), "state");
    writeFileSync(legacy.logFile, "legacy-log");
    writeFileSync(join(legacy.runtimeDir, "runtime-entry"), "runtime");
    writeFileSync(legacy.pidFile, JSON.stringify({ pid: 999_999 }));
    writeFileSync(join(legacy.runtimeDir, "cockpit-web.lock"), JSON.stringify({ pid: 999_999 }));

    const migrated = migrateLegacyCockpitLayout({ env, cwd: "/" });

    expect(migrated.status).toBe("migrated");
    expect(readFileSync(hub.configFile, "utf8")).toContain("listen");
    expect(readFileSync(hub.databasePath, "utf8")).toBe("legacy-db");
    expect(readFileSync(join(hub.cacheDir, "cache-entry"), "utf8")).toBe("cache");
    expect(readFileSync(join(hub.stateDir, "state-entry"), "utf8")).toBe("state");
    expect(readFileSync(hub.logFile, "utf8")).toBe("legacy-log");
    expect(readFileSync(join(hub.runtimeDir, "runtime-entry"), "utf8")).toBe("runtime");
    expect(existsSync(hub.pidFile)).toBe(true);
    expect(existsSync(join(hub.runtimeDir, "hub-web.lock"))).toBe(true);
    expect(existsSync(legacy.databasePath)).toBe(false);
    expect(migrateLegacyCockpitLayout({ env, cwd: "/" })).toEqual({
      status: "not-needed",
      moves: [],
    });
    expect(root.length).toBeGreaterThan(0);
  });

  it("migrates the categorized SPARK_HOME tree", async () => {
    const { root, env } = await fixtureEnvironment();
    env.SPARK_HOME = join(root, "spark-home");
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    const hub = resolveSparkPaths({ app: "hub", env, cwd: "/" });
    mkdirSync(legacy.dataDir, { recursive: true });
    mkdirSync(legacy.configDir, { recursive: true });
    writeFileSync(legacy.databasePath, "legacy-db");
    writeFileSync(legacy.configFile, "port = 4173\n");

    migrateLegacyCockpitLayout({ env, cwd: "/" });

    expect(readFileSync(hub.databasePath, "utf8")).toBe("legacy-db");
    expect(readFileSync(hub.configFile, "utf8")).toContain("4173");
  });

  it("merges legacy cache entries into an existing Hub cache tree", async () => {
    const { env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    const hub = resolveSparkPaths({ app: "hub", env, cwd: "/" });
    mkdirSync(join(legacy.cacheDir, "nested"), { recursive: true });
    mkdirSync(join(hub.cacheDir, "nested"), { recursive: true });
    writeFileSync(join(legacy.cacheDir, "legacy-only"), "legacy");
    writeFileSync(join(hub.cacheDir, "hub-only"), "hub");
    writeFileSync(join(legacy.cacheDir, "nested", "shared"), "same");
    writeFileSync(join(hub.cacheDir, "nested", "shared"), "same");

    expect(migrateLegacyCockpitLayout({ env, cwd: "/" }).status).toBe("migrated");

    expect(readFileSync(join(hub.cacheDir, "legacy-only"), "utf8")).toBe("legacy");
    expect(readFileSync(join(hub.cacheDir, "hub-only"), "utf8")).toBe("hub");
    expect(readFileSync(join(hub.cacheDir, "nested", "shared"), "utf8")).toBe("same");
    expect(existsSync(legacy.cacheDir)).toBe(false);
  });

  it("fails before mutation when existing cache files differ", async () => {
    const { env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    const hub = resolveSparkPaths({ app: "hub", env, cwd: "/" });
    mkdirSync(legacy.cacheDir, { recursive: true });
    mkdirSync(hub.cacheDir, { recursive: true });
    writeFileSync(join(legacy.cacheDir, "shared"), "legacy");
    writeFileSync(join(hub.cacheDir, "shared"), "hub");

    expect(() => migrateLegacyCockpitLayout({ env, cwd: "/" })).toThrow(
      HubLayoutMigrationConflictError,
    );
    expect(readFileSync(join(legacy.cacheDir, "shared"), "utf8")).toBe("legacy");
    expect(readFileSync(join(hub.cacheDir, "shared"), "utf8")).toBe("hub");
  });

  it("rolls completed renames back when a later migration step fails", async () => {
    const { env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    const hub = resolveSparkPaths({ app: "hub", env, cwd: "/" });
    mkdirSync(legacy.configDir, { recursive: true });
    mkdirSync(legacy.dataDir, { recursive: true });
    writeFileSync(legacy.configFile, "legacy-config");
    writeFileSync(legacy.databasePath, "legacy-db");

    expect(() =>
      migrateLegacyCockpitLayout(
        { env, cwd: "/" },
        {
          afterMove(_move, index) {
            if (index === 1) throw new Error("injected migration failure");
          },
        },
      ),
    ).toThrow(/injected migration failure/u);

    expect(readFileSync(legacy.configFile, "utf8")).toBe("legacy-config");
    expect(readFileSync(legacy.databasePath, "utf8")).toBe("legacy-db");
    expect(existsSync(hub.configFile)).toBe(false);
    expect(existsSync(hub.databasePath)).toBe(false);
  });

  it("fails before mutation when canonical and legacy state conflict", async () => {
    const { env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    const hub = resolveSparkPaths({ app: "hub", env, cwd: "/" });
    mkdirSync(legacy.dataDir, { recursive: true });
    mkdirSync(hub.dataDir, { recursive: true });
    writeFileSync(legacy.databasePath, "legacy-db");
    writeFileSync(hub.databasePath, "hub-db");

    expect(() => migrateLegacyCockpitLayout({ env, cwd: "/" })).toThrow(
      HubLayoutMigrationConflictError,
    );
    expect(readFileSync(legacy.databasePath, "utf8")).toBe("legacy-db");
    expect(readFileSync(hub.databasePath, "utf8")).toBe("hub-db");
  });

  it("fails closed while the retired Web process record belongs to a live process", async () => {
    const { env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    mkdirSync(legacy.runtimeDir, { recursive: true });
    writeFileSync(
      join(legacy.runtimeDir, "cockpit-web.lock"),
      JSON.stringify({ pid: process.pid, processStartToken: "current" }),
    );

    expect(() => migrateLegacyCockpitLayout({ env, cwd: "/" })).toThrow(
      HubLayoutMigrationLockedError,
    );
    expect(existsSync(join(legacy.runtimeDir, "cockpit-web.lock"))).toBe(true);
  });

  it("fails closed while the retired database lock belongs to a live process", async () => {
    const { env } = await fixtureEnvironment();
    const legacy = resolveLegacyCockpitPaths({ env, cwd: "/" });
    mkdirSync(legacy.dataDir, { recursive: true });
    writeFileSync(legacy.databasePath, "legacy-db");
    writeFileSync(
      `${legacy.databasePath}.lock`,
      JSON.stringify({ pid: process.pid, ownerToken: "legacy", databasePath: legacy.databasePath }),
    );

    expect(() => migrateLegacyCockpitLayout({ env, cwd: "/" })).toThrow(
      HubLayoutMigrationLockedError,
    );
    expect(readFileSync(legacy.databasePath, "utf8")).toBe("legacy-db");
  });
});

async function fixtureEnvironment(): Promise<{
  root: string;
  env: Record<string, string | undefined>;
}> {
  const root = await mkdtemp(join(tmpdir(), "spark-hub-layout-"));
  roots.push(root);
  return {
    root,
    env: {
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
  };
}
