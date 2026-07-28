import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sparkLocalRpcProcedureSchemas,
  type SparkLocalRpcMethod,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { upsertSparkDaemonServerProfile } from "../server-profiles.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { ensureLocalWorkspace } from "../store/workspaces.ts";
import { handleLocalRpcLine } from "./dispatch.ts";
import { invokeLocalRpcService, localRpcServiceHandlerMethodGroups } from "./service.ts";
import { parseLocalRpcServiceOutput, SparkDaemonStillStartingError } from "./types.ts";

describe("transport-neutral local RPC service", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy envelope outside the shared service", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    const { paths, db } = createFixture();
    ensureLocalWorkspace(db, { localPath: join(paths.dataDir, "workspace") });

    const direct = await invokeLocalRpcService("workspace.list", {}, { paths, db });
    const legacy = await handleLocalRpcLine(
      JSON.stringify({ id: "rpc_workspace_list", method: "workspace.list" }),
      paths,
      db,
      undefined,
    );

    expect(direct).not.toHaveProperty("id");
    expect(direct).not.toHaveProperty("ok");
    expect(legacy).toEqual({ id: "rpc_workspace_list", ok: true, result: direct });
    db.close();
  });

  it("shares readiness semantics while preserving the legacy error envelope", async () => {
    const { paths, db } = createFixture();
    const handlerOptions = { isReady: () => false };

    await expect(
      invokeLocalRpcService("session.list", {}, { paths, db, handlerOptions }),
    ).rejects.toBeInstanceOf(SparkDaemonStillStartingError);
    await expect(
      handleLocalRpcLine(
        JSON.stringify({ id: "rpc_starting", method: "session.list", params: {} }),
        paths,
        db,
        undefined,
        handlerOptions,
      ),
    ).resolves.toEqual({
      id: "rpc_starting",
      ok: false,
      error: {
        code: "daemon_starting",
        message: "Spark daemon is still starting; retry after readiness.",
      },
    });
    db.close();
  });

  it("never projects uplink credentials through service or legacy results", async () => {
    const { paths, db } = createFixture();
    const serverUrl = "https://cockpit.example.test/";
    await upsertSparkDaemonServerProfile(paths, {
      serverUrl,
      runtimeId: "rt_private",
      runtimeToken: "token_private",
      refreshToken: "refresh_private",
    });

    const direct = await invokeLocalRpcService("uplink.park", { serverUrl }, { paths, db });
    const legacy = await handleLocalRpcLine(
      JSON.stringify({
        id: "rpc_unpark",
        method: "uplink.unpark",
        params: { serverUrl },
      }),
      paths,
      db,
      undefined,
    );

    expect(direct).toEqual({ serverUrl, parked: true });
    expect(legacy).toEqual({
      id: "rpc_unpark",
      ok: true,
      result: { serverUrl, parked: false },
    });
    expect(JSON.stringify({ direct, legacy })).not.toContain("private");
    db.close();
  });

  it("exhaustively groups all 66 methods behind their protocol output parser", () => {
    const groupedMethods = Object.values(localRpcServiceHandlerMethodGroups).flat();
    const catalogMethods = Object.keys(sparkLocalRpcProcedureSchemas) as SparkLocalRpcMethod[];

    expect(groupedMethods).toHaveLength(66);
    expect(new Set(groupedMethods).size).toBe(groupedMethods.length);
    expect([...groupedMethods].sort()).toEqual([...catalogMethods].sort());

    for (const method of catalogMethods) {
      const raw = { rawMethod: method };
      const sentinel = { parsedMethod: method };
      const outputSchema = sparkLocalRpcProcedureSchemas[method].output as {
        parse(value: unknown): unknown;
      };
      const parse = vi.spyOn(outputSchema, "parse").mockReturnValueOnce(sentinel);

      expect(parseLocalRpcServiceOutput(method, raw)).toBe(sentinel);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(parse).toHaveBeenCalledWith(raw);
      parse.mockRestore();
    }
  });

  function createFixture() {
    const root = mkdtempSync(join(tmpdir(), "spark-local-rpc-service-"));
    roots.push(root);
    const paths = resolveSparkPaths({
      app: "daemon",
      env: { HOME: root },
      overrides: {
        dataDir: join(root, "data"),
        cacheDir: join(root, "cache"),
        stateDir: join(root, "state"),
        runtimeDir: join(root, "run"),
      },
    });
    return { paths, db: openSparkDaemonDatabase(paths) };
  }
});
