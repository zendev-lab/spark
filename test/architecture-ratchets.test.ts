import { describe, expect, it } from "vitest";

// @ts-expect-error The executable architecture script intentionally has no declaration surface.
import * as architectureRatchets from "../scripts/check-architecture-ratchets.mjs";

const { findLegacyDaemonClientViolations, isLegacyDaemonClientBoundaryExempt } =
  architectureRatchets;

describe("legacy daemon client architecture ratchet", () => {
  it("rejects the compatibility subpath and legacy request symbols", () => {
    expect(
      findLegacyDaemonClientViolations(`
        import { requestSparkDaemonLocalRpc } from "@zendev-lab/spark-daemon-client/local-rpc";
        await requestSparkDaemonLocalRpc("daemon.status", {});
      `),
    ).toEqual(["legacy local-rpc subpath import", "legacy request symbol"]);
    expect(
      findLegacyDaemonClientViolations(
        `await requestSparkDaemonLocalRpcWire({ id: "1", method: "daemon.status" });`,
      ),
    ).toEqual(["legacy request symbol"]);
  });

  it("allows the typed facade, comments, and string data", () => {
    expect(
      findLegacyDaemonClientViolations(`
        import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";
        // requestSparkDaemonLocalRpc is a retired compatibility symbol.
        const migrationNote = "requestSparkDaemonLocalRpcWire";
        await requestSparkDaemon("daemon.status", {});
      `),
    ).toEqual([]);
  });

  it("exempts only tests, fixtures, and the two compatibility implementation files", () => {
    for (const path of [
      "apps/example/src/__fixtures__/legacy.ts",
      "apps/example/src/legacy.fixture.ts",
      "apps/example/src/legacy.test.ts",
      "packages/spark-daemon-client/src/daemon-client.ts",
      "packages/spark-daemon-client/src/daemon-local-rpc.ts",
    ]) {
      expect(isLegacyDaemonClientBoundaryExempt(path), path).toBe(true);
    }
    for (const path of [
      "apps/spark-daemon/src/local-rpc/transport.ts",
      "packages/spark-daemon-client/src/daemon-local-rpc-orpc.ts",
      "packages/spark-session/src/action-tool.ts",
    ]) {
      expect(isLegacyDaemonClientBoundaryExempt(path), path).toBe(false);
    }
    expect(
      findLegacyDaemonClientViolations(`
        export function handleLocalRpcLine(line: string) {
          return dispatchLegacyEnvelope(JSON.parse(line));
        }
      `),
    ).toEqual([]);
  });
});
