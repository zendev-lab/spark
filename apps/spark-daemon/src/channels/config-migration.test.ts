import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { channelConfigPath, resolveSparkPaths } from "@zendev-lab/spark-system";
import { migrateDaemonChannelsConfig } from "./config-migration.ts";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "spark-channel-config-"));
  roots.push(value);
  return value;
}

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

const qq = (secret: string) => ({
  adapters: {
    qq: { type: "qqbot", app_id: "qq-app", client_secret: secret },
  },
  routes: { alerts: { adapter: "qq", recipient: "c2c:operator" } },
  ingress: { enabled: true },
});

describe("daemon-global Channel config migration", () => {
  it("merges identical account configs, writes a private target, journal, and backups", async () => {
    const sparkHome = await root();
    const globalPath = join(sparkHome, "channels", "config.json");
    const workspacePath = join(sparkHome, "workspaces", "ws-1", "channels", "config.json");
    await writeConfig(globalPath, qq("secret"));
    await writeConfig(workspacePath, {
      ...qq("secret"),
      adapters: { renamed: qq("secret").adapters.qq },
      routes: { audit: { adapter: "renamed", recipient: "group:audit" } },
    });

    const result = await migrateDaemonChannelsConfig({ sparkHome });
    expect(result).toMatchObject({ state: "ready", migrated: true });
    if (result.state !== "ready") throw new Error("expected ready config");
    expect(Object.keys(result.config.adapters)).toEqual(["qq"]);
    expect(result.config.routes.audit?.adapter).toBe("qq");
    const target = channelConfigPath(resolveSparkPaths({ app: "daemon", sparkHome }));
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(`${target}.migration.json`, "utf8"))).toMatchObject({
      state: "complete",
    });
    await expect(stat(`${globalPath}.daemon-global.bak`)).resolves.toBeDefined();
    await expect(stat(`${workspacePath}.daemon-global.bak`)).resolves.toBeDefined();

    await expect(migrateDaemonChannelsConfig({ sparkHome })).resolves.toMatchObject({
      state: "ready",
      migrated: false,
    });
  });

  it("fails closed with a redacted conflict when one account has divergent secrets", async () => {
    const sparkHome = await root();
    await writeConfig(join(sparkHome, "channels", "config.json"), qq("old-secret"));
    await writeConfig(
      join(sparkHome, "workspaces", "private-workspace", "channels", "config.json"),
      qq("rotated-secret"),
    );

    const result = await migrateDaemonChannelsConfig({ sparkHome });
    expect(result.state).toBe("conflict");
    if (result.state !== "conflict") throw new Error("expected conflict");
    const report = JSON.stringify(result.conflicts);
    expect(report).not.toContain("old-secret");
    expect(report).not.toContain("rotated-secret");
    expect(report).not.toContain("private-workspace");
    await expect(readFile(result.path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a corrupt target and leaves listeners unconfigured", async () => {
    const sparkHome = await root();
    const target = channelConfigPath(resolveSparkPaths({ app: "daemon", sparkHome }));
    await writeConfig(target, { broken: true });

    await expect(migrateDaemonChannelsConfig({ sparkHome })).resolves.toMatchObject({
      state: "conflict",
      conflicts: [{ kind: "corrupt" }],
    });
  });
});
