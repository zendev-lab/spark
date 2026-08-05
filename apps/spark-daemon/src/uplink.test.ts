import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { SparkDaemonControlError } from "./control-error.ts";
import {
  desiredUplinkServerUrls,
  parkSparkDaemonUplink,
  preferSparkDaemonWorkspaceUplink,
  preferSparkDaemonWorkspaceUplinkWithTransfer,
  sparkDaemonUplinkStatus,
  SparkDaemonLeaseTransferBroker,
  unparkSparkDaemonUplink,
} from "./uplink.js";
import { upsertSparkDaemonServerProfile } from "./server-profiles.js";
import { openSparkDaemonDatabase } from "./store/schema.js";
import { attachWorkspaceClient, getWorkspaceById, registerWorkspace } from "./store/workspaces.js";

const roots: string[] = [];

function expectControlError(run: () => unknown, code: SparkDaemonControlError["code"]): void {
  try {
    run();
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SparkDaemonControlError);
    expect(error).toMatchObject({ code });
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("daemon uplink park/prefer", () => {
  it("reports invalid operator choices with stable uplink codes", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-errors-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "known");
    mkdirSync(workspacePath, { recursive: true });
    const workspace = registerWorkspace(db, {
      serverUrl: "https://current.example/",
      localPath: workspacePath,
      localWorkspaceKey: "known",
      displayName: "known",
    });

    await expect(parkSparkDaemonUplink(paths, "not a URL")).rejects.toMatchObject({
      name: "SparkDaemonControlError",
      code: "uplink_url_invalid",
    });
    await expect(parkSparkDaemonUplink(paths, "https://missing.example/")).rejects.toMatchObject({
      name: "SparkDaemonControlError",
      code: "uplink_profile_not_found",
    });

    const unrunnable = "https://unrunnable.example/";
    await upsertSparkDaemonServerProfile(paths, { serverUrl: unrunnable });
    expectControlError(
      () =>
        preferSparkDaemonWorkspaceUplink(paths, db, {
          workspace: workspace.id,
          serverUrl: unrunnable,
        }),
      "uplink_profile_unrunnable",
    );

    const parked = "https://parked.example/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: parked,
      runtimeId: "rt_dddddddddddddddddddddddddddddddd",
      runtimeToken: "spark_rt_access_33333333333333333333333333333333",
      parked: true,
    });
    expectControlError(
      () =>
        preferSparkDaemonWorkspaceUplink(paths, db, {
          workspace: workspace.id,
          serverUrl: parked,
        }),
      "uplink_parked",
    );

    const target = "https://target.example/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: target,
      runtimeId: "rt_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      runtimeToken: "spark_rt_access_44444444444444444444444444444444",
    });
    expectControlError(
      () =>
        preferSparkDaemonWorkspaceUplink(paths, db, {
          workspace: "workspace-missing",
          serverUrl: target,
        }),
      "uplink_workspace_not_found",
    );

    for (const suffix of ["one", "two"]) {
      const duplicatePath = join(root, suffix);
      mkdirSync(duplicatePath);
      registerWorkspace(db, {
        serverUrl: "https://current.example/",
        localPath: duplicatePath,
        localWorkspaceKey: suffix,
        displayName: "duplicate",
      });
    }
    expectControlError(
      () =>
        preferSparkDaemonWorkspaceUplink(paths, db, {
          workspace: "duplicate",
          serverUrl: target,
        }),
      "uplink_workspace_ambiguous",
    );
    db.close();
  });

  it("omits parked origins from the desired uplink set and restores on unpark", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-park-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "checkout");
    mkdirSync(workspacePath, { recursive: true });
    const serverUrl = "http://127.0.0.1:5173/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl,
      runtimeId: "rt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      runtimeToken: "spark_rt_access_00000000000000000000000000000000",
    });
    registerWorkspace(db, {
      serverUrl,
      localPath: workspacePath,
      localWorkspaceKey: "checkout",
      displayName: "checkout",
      serverBindingId: "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      serverWorkspaceId: "ws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect([...desiredUplinkServerUrls(paths, db)]).toEqual([serverUrl]);
    await parkSparkDaemonUplink(paths, serverUrl);
    expect([...desiredUplinkServerUrls(paths, db)]).toEqual([]);
    expect(sparkDaemonUplinkStatus(paths, db).origins[0]).toMatchObject({
      serverUrl,
      parked: true,
      desired: false,
    });
    await unparkSparkDaemonUplink(paths, serverUrl);
    expect([...desiredUplinkServerUrls(paths, db)]).toEqual([serverUrl]);
    db.close();
  });

  it("prefers a workspace onto another runnable origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-prefer-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "spark");
    mkdirSync(workspacePath, { recursive: true });
    const prod = "https://prod.example/";
    const local = "http://127.0.0.1:5173/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: prod,
      runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeToken: "spark_rt_access_11111111111111111111111111111111",
    });
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: local,
      runtimeId: "rt_cccccccccccccccccccccccccccccccc",
      runtimeToken: "spark_rt_access_22222222222222222222222222222222",
    });
    const workspace = registerWorkspace(db, {
      serverUrl: prod,
      localPath: workspacePath,
      localWorkspaceKey: "spark",
      displayName: "spark",
      serverBindingId: "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    const preferred = preferSparkDaemonWorkspaceUplink(paths, db, {
      workspace: workspace.id,
      serverUrl: local,
    });
    expect(preferred.previousServerUrl).toBe(prod);
    expect(preferred.serverUrl).toBe(local);
    expect(getWorkspaceById(db, workspace.id)?.serverUrl).toBe(local);
    db.close();
  });

  it("waits for transfer consent when interactive sessions occupy the workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-transfer-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "spark");
    mkdirSync(workspacePath, { recursive: true });
    const prod = "https://prod.example/";
    const local = "http://127.0.0.1:5173/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: prod,
      runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeToken: "spark_rt_access_11111111111111111111111111111111",
    });
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: local,
      runtimeId: "rt_cccccccccccccccccccccccccccccccc",
      runtimeToken: "spark_rt_access_22222222222222222222222222222222",
    });
    const workspace = registerWorkspace(db, {
      serverUrl: prod,
      localPath: workspacePath,
      localWorkspaceKey: "spark",
      displayName: "spark",
      serverBindingId: "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    attachWorkspaceClient(db, {
      workspaceId: workspace.id,
      clientId: "wcl-tui-1",
      kind: "interactive",
      metadata: { surface: "tui" },
    });

    const transfers = new SparkDaemonLeaseTransferBroker();
    const preferPromise = preferSparkDaemonWorkspaceUplinkWithTransfer(
      paths,
      db,
      { workspace: workspace.id, serverUrl: local },
      { transfers, timeoutMs: 5_000 },
    );
    const pending = transfers.pendingForWorkspace(workspace.id);
    expect(pending).toMatchObject({
      workspaceId: workspace.id,
      targetServerUrl: local,
    });
    transfers.respond(pending!.transferId, "accept", "tui");
    const preferred = await preferPromise;
    expect(preferred.serverUrl).toBe(local);
    expect(preferred.transfer).toMatchObject({ decision: "accept", source: "tui" });
    expect(getWorkspaceById(db, workspace.id)?.serverUrl).toBe(local);
    db.close();
  });

  it("rejects occupied prefer when an occupying session denies transfer", async () => {
    const root = mkdtempSync(join(tmpdir(), "spark-daemon-uplink-transfer-deny-"));
    roots.push(root);
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
    const db = openSparkDaemonDatabase(paths);
    const workspacePath = join(root, "spark");
    mkdirSync(workspacePath, { recursive: true });
    const prod = "https://prod.example/";
    const local = "http://127.0.0.1:5173/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: prod,
      runtimeId: "rt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeToken: "spark_rt_access_11111111111111111111111111111111",
    });
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl: local,
      runtimeId: "rt_cccccccccccccccccccccccccccccccc",
      runtimeToken: "spark_rt_access_22222222222222222222222222222222",
    });
    const workspace = registerWorkspace(db, {
      serverUrl: prod,
      localPath: workspacePath,
      localWorkspaceKey: "spark",
      displayName: "spark",
      serverBindingId: "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    attachWorkspaceClient(db, {
      workspaceId: workspace.id,
      clientId: "wcl-hub-1",
      kind: "interactive",
      metadata: { surface: "hub" },
    });

    const transfers = new SparkDaemonLeaseTransferBroker();
    const preferPromise = preferSparkDaemonWorkspaceUplinkWithTransfer(
      paths,
      db,
      { workspace: workspace.id, serverUrl: local },
      { transfers, timeoutMs: 5_000 },
    );
    const pending = transfers.pendingForWorkspace(workspace.id)!;
    transfers.respond(pending.transferId, "reject", "hub");
    await expect(preferPromise).rejects.toMatchObject({
      name: "SparkDaemonControlError",
      code: "uplink_transfer_rejected",
    });
    expect(getWorkspaceById(db, workspace.id)?.serverUrl).toBe(prod);
    db.close();
  });
});
