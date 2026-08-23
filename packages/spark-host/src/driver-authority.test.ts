import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSparkSessionWorkspaceState } from "@zendev-lab/spark-loop";
import {
  SPARK_PROTOCOL_VERSION,
  parseSparkInteractionResponse,
  type SparkInteractionResponse,
} from "@zendev-lab/spark-protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  SPARK_DRIVER_AUTHORITY_DENY,
  SPARK_DRIVER_AUTHORITY_GRANT,
  SPARK_DRIVER_AUTHORITY_QUESTION_ID,
  createDriverAuthorityAskRequest,
  driverAuthorityFromAskResponse,
} from "./driver-authority.ts";
import { SparkHostRuntime } from "./runtime.ts";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spark-driver-authority-"));
  dirs.push(dir);
  return dir;
}

function askResponse(
  status: SparkInteractionResponse["status"],
  values?: string[],
): SparkInteractionResponse {
  return parseSparkInteractionResponse({
    version: SPARK_PROTOCOL_VERSION,
    kind: "askFlow",
    requestId: "driver-authority:test",
    status,
    answers: values === undefined ? {} : { [SPARK_DRIVER_AUTHORITY_QUESTION_ID]: { values } },
  });
}

describe("driverAuthorityFromAskResponse", () => {
  it("maps grant, deny, and cancel, and leaves blocked unanswered", () => {
    const request = createDriverAuthorityAskRequest();
    expect(request.kind).toBe("askFlow");
    if (request.kind !== "askFlow") return;
    expect(request.flow).toBe("spark.driver-authority");
    expect(request.questions[0]?.id).toBe(SPARK_DRIVER_AUTHORITY_QUESTION_ID);
    expect(request.questions[0]?.options.map((option) => option.value)).toEqual([
      SPARK_DRIVER_AUTHORITY_GRANT,
      SPARK_DRIVER_AUTHORITY_DENY,
    ]);

    expect(driverAuthorityFromAskResponse(askResponse("answered", ["grant"]))).toBe("granted");
    expect(driverAuthorityFromAskResponse(askResponse("answered", ["deny"]))).toBe("denied");
    expect(driverAuthorityFromAskResponse(askResponse("cancelled"))).toBe("denied");
    expect(driverAuthorityFromAskResponse(askResponse("blocked"))).toBeUndefined();
    expect(driverAuthorityFromAskResponse(askResponse("answered", []))).toBeUndefined();
    expect(
      driverAuthorityFromAskResponse(
        parseSparkInteractionResponse({
          version: SPARK_PROTOCOL_VERSION,
          kind: "toolApproval",
          requestId: "other",
          status: "answered",
          approved: true,
        }),
      ),
    ).toBeUndefined();
  });
});

describe("SparkHostRuntime.ensureDriverAuthority", () => {
  it("silently grants and persists on non-interactive hosts", async () => {
    const dir = await tempDir();
    let asked = 0;
    const host = new SparkHostRuntime({
      cwd: dir,
      hasUI: false,
      ui: {
        interaction: async () => {
          asked += 1;
          return askResponse("answered", ["deny"]);
        },
      },
    });
    host.setSessionId("session:silent");

    await expect(host.ensureDriverAuthority(host.makeContext())).resolves.toBe("granted");
    expect(asked).toBe(0);
    await expect(
      loadSparkSessionWorkspaceState(dir, { sessionId: "session:silent" }),
    ).resolves.toEqual({
      version: 5,
      driverAuthority: "granted",
    });
  });

  it("asks once on interactive hosts and persists the grant", async () => {
    const dir = await tempDir();
    const kinds: string[] = [];
    const host = new SparkHostRuntime({
      cwd: dir,
      hasUI: true,
      ui: {
        interaction: async (request) => {
          kinds.push(request.kind);
          return askResponse("answered", ["grant"]);
        },
      },
    });
    host.setSessionId("session:grant");

    await expect(host.ensureDriverAuthority(host.makeContext())).resolves.toBe("granted");
    await expect(host.ensureDriverAuthority(host.makeContext())).resolves.toBe("granted");
    expect(kinds).toEqual(["askFlow"]);
    await expect(
      loadSparkSessionWorkspaceState(dir, { sessionId: "session:grant" }),
    ).resolves.toEqual({
      version: 5,
      driverAuthority: "granted",
    });
  });

  it("persists deny from an interactive refusal", async () => {
    const dir = await tempDir();
    const host = new SparkHostRuntime({
      cwd: dir,
      hasUI: true,
      ui: {
        interaction: async () => askResponse("answered", ["deny"]),
      },
    });
    host.setSessionId("session:deny");

    await expect(host.ensureDriverAuthority(host.makeContext())).resolves.toBe("denied");
    await expect(
      loadSparkSessionWorkspaceState(dir, { sessionId: "session:deny" }),
    ).resolves.toEqual({
      version: 5,
      driverAuthority: "denied",
    });
  });

  it("returns denied without persisting when the UI handler is missing", async () => {
    const dir = await tempDir();
    const host = new SparkHostRuntime({ cwd: dir, hasUI: true });
    host.setSessionId("session:blocked");

    await expect(host.ensureDriverAuthority(host.makeContext())).resolves.toBe("denied");
    await expect(
      loadSparkSessionWorkspaceState(dir, { sessionId: "session:blocked" }),
    ).resolves.toBeUndefined();
  });
});
