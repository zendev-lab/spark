import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { runSparkHubAppCli } from "../apps/spark-hub/src/cli.ts";
import { parseSparkCliCommand } from "../apps/spark-tui/src/cli.ts";

// @ts-expect-error executable compatibility script intentionally exposes a JS API for tests.
import * as compatibility from "../scripts/test-adjacent-product-compatibility.mjs";

function matrix(candidateVersion: string, baselineVersion: string, phases: unknown[]) {
  return {
    candidate: { version: candidateVersion, identities: {} },
    baseline: { version: baselineVersion, identities: {} },
    phases,
    cleanup: {},
  };
}

const {
  PHASE_SPECS,
  REQUIRED_PHASES,
  assertPackagedExecutable,
  legacyException,
  parse,
  parseCompatibilityArguments,
  runPhase,
  selectBaseline,
  selectPublishedBaselineVersion,
  validateMatrixReport,
  validatePhaseReport,
  validateReport,
} = compatibility;

test("Hub compatibility product command is hidden and JSON-only", async () => {
  await assert.rejects(() => runSparkHubAppCli(["__compat-product"]), /Usage: __compat-product/u);
  await assert.rejects(
    () =>
      runSparkHubAppCli([
        "__compat-product",
        "prepare",
        "--unexpected",
        "--database",
        "/tmp/hub.sqlite",
        "--json",
      ]),
    /Unknown __compat-product prepare argument/u,
  );
});

test("TUI compatibility probe is hidden, product-owned, and JSON-only", () => {
  assert.deepEqual(
    parseSparkCliCommand([
      "__compat-product",
      "first",
      "--session",
      "sess_1",
      "--invocation",
      "inv_1",
      "--json",
    ]),
    {
      kind: "compat-product",
      action: "first",
      json: true,
      sessionId: "sess_1",
      invocationId: "inv_1",
    },
  );
  assert.deepEqual(parseSparkCliCommand(["__compat-product", "first", "--json"]), {
    kind: "error",
    message: "first requires --session --invocation",
  });
  assert.deepEqual(parseSparkCliCommand(["__compat-product"]), {
    kind: "error",
    message: "__compat-product requires first or resume",
  });
  assert.deepEqual(
    parseSparkCliCommand([
      "__compat-product",
      "resume",
      "--session",
      "sess_1",
      "--invocation",
      "inv_1",
      "--cursor",
      "7",
      "--json",
    ]),
    {
      kind: "compat-product",
      action: "resume",
      json: true,
      sessionId: "sess_1",
      invocationId: "inv_1",
      cursor: 7,
    },
  );
  assert.throws(() => parseSparkCliCommand(["compat-probe", "--json"]), /Unknown spark option/u);
});

test("requires all three candidate exact product tarballs and an explicit baseline", () => {
  assert.throws(() => parseCompatibilityArguments([]), /Missing candidate exact tarballs/u);
  assert.throws(
    () =>
      parseCompatibilityArguments([
        "--baseline-version",
        "0.3.0",
        "--candidate-hub-tarball",
        "h.tgz",
        "--candidate-daemon-tarball",
        "d.tgz",
      ]),
    /Missing candidate exact tarballs.*candidateTuiTarball/u,
  );
  assert.deepEqual(
    parseCompatibilityArguments([
      "--baseline-version",
      "0.3.0",
      "--candidate-hub-tarball",
      "h.tgz",
      "--candidate-daemon-tarball",
      "d.tgz",
      "--candidate-tui-tarball",
      "t.tgz",
    ]),
    {
      baselineVersion: "0.3.0",
      candidateHubTarball: "h.tgz",
      candidateDaemonTarball: "d.tgz",
      candidateTuiTarball: "t.tgz",
    },
  );
});

test("exports canonical parse/selectBaseline aliases", () => {
  assert.equal(parse, parseCompatibilityArguments);
  assert.equal(selectBaseline, selectPublishedBaselineVersion);
});

test("refuses source checkout and root CLI fallbacks", () => {
  assertPackagedExecutable(
    "/tmp/node_modules/@zendev-lab/spark-hub/bin/spark-hub",
    "@zendev-lab/spark-hub",
  );
  assert.throws(
    () => assertPackagedExecutable("/repo/apps/spark-hub/bin/spark-hub", "@zendev-lab/spark-hub"),
    /Refusing non-packaged/u,
  );
  assert.throws(
    () =>
      assertPackagedExecutable(
        "/tmp/node_modules/@zendev-lab/spark/bin/spark",
        "@zendev-lab/spark-hub",
      ),
    /Refusing non-packaged/u,
  );
});

test("phase report rejects no-op, duplicate, wrong, and incomplete reports", () => {
  assert.throws(
    () =>
      validatePhaseReport({
        id: "wrong",
        status: "passed",
        assertions: [{ status: "passed" }],
        cleanup: {},
      }),
    /unknown phase/u,
  );
  assert.throws(
    () =>
      validatePhaseReport({
        id: REQUIRED_PHASES[0],
        status: "passed",
        assertions: [],
        cleanup: {},
      }),
    /no assertions/u,
  );
  assert.throws(
    () =>
      validatePhaseReport({
        id: REQUIRED_PHASES[0],
        status: "passed",
        assertions: [{ status: "failed" }],
        cleanup: {},
      }),
    /non-passed/u,
  );
  const phase = {
    id: REQUIRED_PHASES[0],
    status: "passed",
    assertions: [{ id: "transport", status: "passed" }],
    cleanup: { verified: true },
  };
  assert.throws(
    () =>
      validateMatrixReport(
        matrix("0.4.0", "0.3.0", [phase, phase, { id: "candidate-same-version" }]),
        "0.4.0",
        "0.3.0",
      ),
    /duplicate phase/u,
  );
  assert.throws(
    () =>
      validateMatrixReport(
        matrix("0.4.0", "0.3.0", [phase, { id: "candidate-same-version" }]),
        "0.4.0",
        "0.3.0",
      ),
    /missing required phases/u,
  );
});

test("selects the latest published non-exempt compatibility baseline", () => {
  assert.equal(
    selectPublishedBaselineVersion(["0.2.1", "0.3.0", "0.4.0", "0.5.0-beta.1"], "0.5.0", ["0.4.0"]),
    "0.3.0",
  );
  assert.equal(
    selectPublishedBaselineVersion(["0.2.1", "0.3.0", "0.4.0-beta.1"], "0.4.0"),
    "0.3.0",
  );
});

test("0.3.0 to 0.2.1 is only the bounded split exception", () => {
  assert.equal(legacyException("0.3.0", "0.2.1"), true);
  assert.equal(legacyException("0.4.0", "0.3.0"), false);
  assert.equal(legacyException("0.3.0", "0.3.0"), false);
  assert.throws(
    () => validateMatrixReport(matrix("0.4.0", "0.2.1", []), "0.4.0", "0.2.1"),
    /0.2.1 is only valid/u,
  );
  const ids = REQUIRED_PHASES.map((id: string) => ({
    id,
    status: "not-applicable",
    reason: "legacy split exception",
    assertions: [{ id: "exception", status: "not-applicable" }],
    cleanup: { verified: true },
  }));
  assert.doesNotThrow(() =>
    validateMatrixReport(
      matrix("0.3.0", "0.2.1", [...ids, { id: "candidate-same-version" }]),
      "0.3.0",
      "0.2.1",
    ),
  );
});

test("matrix report requires identities, cleanup, and candidate same-version sanity", () => {
  assert.throws(
    () =>
      validateMatrixReport(
        { candidate: { version: "0.4.0" }, baseline: { version: "0.3.0" }, phases: [] },
        "0.4.0",
        "0.3.0",
      ),
    /incomplete/u,
  );
  assert.throws(
    () => validateMatrixReport(matrix("0.4.0", "0.3.0", []), "0.4.0", "0.3.0"),
    /missing candidate same-version/u,
  );
});

test("split baselines cannot be omitted or reported not-applicable", () => {
  const phase = {
    id: REQUIRED_PHASES[0],
    status: "not-applicable",
    reason: "missing baseline",
    assertions: [{ id: "missing", status: "not-applicable" }],
    cleanup: { verified: true },
  };
  assert.throws(
    () =>
      validateMatrixReport(
        matrix("0.4.0", "0.3.0", [
          ...REQUIRED_PHASES.map((id: string) => ({ ...phase, id })),
          { id: "candidate-same-version" },
        ]),
        "0.4.0",
        "0.3.0",
      ),
    /split-product phase cannot be not-applicable/u,
  );
});

test("all four 0.4 product phases exercise injected real processes and exact contract assertions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-product-phase-test-"));
  const children = new Set<ReturnType<typeof spawn>>();
  const registrations = new Set<string>();
  const hubProbeBins: string[] = [];
  const workspacePreparationBins: string[] = [];
  const invocationPreparationBins: string[] = [];
  let baselineTuiCalls = 0;
  let port = 42000;
  const startProcess = () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.add(child);
    return child;
  };
  const stopProcess = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit, reject) => {
        child.once("exit", () => resolveExit());
        child.once("error", reject);
      });
    }
    children.delete(child);
  };
  const runtime = {
    runHub: async (
      _bin: string,
      phaseRoot: string,
      details: unknown[],
      requestedPort?: number,
      probeBin?: string,
    ) => {
      if (probeBin) hubProbeBins.push(probeBin);
      const child = startProcess();
      const selectedPort = requestedPort ?? port++;
      details.push({ operation: "hub-start", pid: child.pid, selectedPort });
      return {
        child,
        identity: { pid: child.pid, startToken: `test:${child.pid}` },
        env: { ORIGIN: `http://127.0.0.1:${selectedPort}` },
        port: selectedPort,
        databasePath: join(phaseRoot, "hub.sqlite"),
        probe: {
          origin: `http://127.0.0.1:${selectedPort}`,
          registrationToken: "test-token",
        },
      };
    },
    runDaemon: async (_bin: string, _phaseRoot: string, details: unknown[]) => {
      const child = startProcess();
      details.push({ operation: "daemon-start", pid: child.pid });
      return { identity: { pid: child.pid, startToken: `test:${child.pid}` }, child };
    },
    prepareDaemonWorkspace: async (bin: string, phaseRoot: string) => {
      workspacePreparationBins.push(bin);
      await writeFile(join(phaseRoot, "local-workspace"), "registered\n");
      return { workspaceId: "ws_local" };
    },
    prepareDaemonInvocation: async (bin: string, phaseRoot: string, workspaceId: string) => {
      invocationPreparationBins.push(bin);
      assert.equal(workspaceId, "ws_local");
      assert.equal(await readFile(join(phaseRoot, "local-workspace"), "utf8"), "registered\n");
      return {
        workspaceId,
        sessionId: "sess_compat",
        invocationId: "inv_compat",
      };
    },
    registerDaemon: async (_bin: string, phaseRoot: string) => {
      registrations.add(phaseRoot);
      await writeFile(join(phaseRoot, "registered"), "uplink\n");
    },
    verifyHubRuntime: async (_bin: string, phaseRoot: string) => {
      assert.equal(await readFile(join(phaseRoot, "registered"), "utf8"), "uplink\n");
      assert.equal(registrations.has(phaseRoot), true);
      return {
        runtimeStatus: "online",
        bindingId: "rtwb_test",
        workspaceId: "ws_test",
        commandStatus: "succeeded",
      };
    },
    createOrGetHubSession: async (
      _bin: string,
      _phaseRoot: string,
      _env: unknown,
      _databasePath: string,
      sessionId?: string,
    ) => ({ session: { sessionId: sessionId ?? "sess_test" } }),
    runTui: async (_bin: string, phaseRoot: string) => {
      await writeFile(join(phaseRoot, "cursor"), "7\n");
      assert.equal(await readFile(join(phaseRoot, "cursor"), "utf8"), "7\n");
      return {
        assertions: {
          handshake: true,
          localRpcStatus: true,
          sessionWrite: true,
          snapshotRead: true,
          eventDecode: true,
          cancelled: true,
          detachRelease: true,
          reconnect: true,
          cursorReconnect: true,
        },
      };
    },
    runBaselineTui: async (_bin: string, _candidateBin: string, phaseRoot: string) => {
      baselineTuiCalls += 1;
      await writeFile(join(phaseRoot, "baseline-cursor"), "9\n");
      return {
        assertions: {
          handshake: true,
          localRpcStatus: true,
          sessionWrite: true,
          snapshotRead: true,
          eventDecode: true,
          cancelled: true,
          detachRelease: true,
          reconnect: true,
          cursorReconnect: true,
        },
      };
    },
    stopChild: async (child: ReturnType<typeof spawn>) => await stopProcess(child),
    stopDaemon: async (_bin: string, _phaseRoot: string, identity: { pid: number }) => {
      const child = [...children].find((candidate) => candidate.pid === identity.pid);
      assert.ok(child);
      await stopProcess(child);
    },
  };
  const installation = (name: string) => ({
    packageName: name,
    identity: { name, version: "0.4.0" },
    bin: `/tmp/node_modules/${name}/bin/product`,
  });
  const installations = {
    candidate: {
      hub: installation("@zendev-lab/spark-hub"),
      daemon: installation("@zendev-lab/spark-daemon"),
      tui: installation("@zendev-lab/spark-tui"),
    },
    baseline: {
      hub: {
        ...installation("@zendev-lab/spark-hub"),
        identity: { name: "@zendev-lab/spark-hub", version: "0.3.0" },
      },
      daemon: {
        ...installation("@zendev-lab/spark-daemon"),
        identity: { name: "@zendev-lab/spark-daemon", version: "0.3.0" },
      },
      tui: {
        ...installation("@zendev-lab/spark-tui"),
        identity: { name: "@zendev-lab/spark-tui", version: "0.3.0" },
      },
    },
  };
  try {
    for (const id of REQUIRED_PHASES) {
      const phase = await runPhase({ id, ...PHASE_SPECS[id] }, installations, root, runtime);
      assert.equal(phase.id, id);
      assert.equal(phase.status, "passed");
      assert.equal(phase.cleanup.status, "passed");
      const expected = id.includes("hub--")
        ? [
            "product-identity",
            "handshake",
            "projection-read",
            "command-delivery",
            "reconnect",
            "cleanup",
          ]
        : [
            "product-identity",
            "local-rpc-status",
            "session-snapshot",
            "event-decoding",
            "cursor-reconnect",
            "cancellation-safe-detach",
            "cleanup",
          ];
      assert.deepEqual(
        phase.assertions.map((assertion: { id: string }) => assertion.id),
        expected,
      );
      assert.equal(
        phase.assertions.every((assertion: { status: string }) => assertion.status === "passed"),
        true,
      );
    }
    assert.equal(baselineTuiCalls, 1);
    assert.deepEqual(workspacePreparationBins, [
      installations.candidate.daemon.bin,
      installations.candidate.daemon.bin,
    ]);
    assert.deepEqual(invocationPreparationBins, [
      installations.candidate.daemon.bin,
      installations.candidate.daemon.bin,
    ]);
    assert.deepEqual(hubProbeBins, [
      installations.candidate.hub.bin,
      installations.candidate.hub.bin,
      installations.candidate.hub.bin,
      installations.candidate.hub.bin,
    ]);
    const failed = await runPhase(
      {
        id: REQUIRED_PHASES[0],
        ...PHASE_SPECS[REQUIRED_PHASES[0]],
      },
      installations,
      root,
      {
        ...runtime,
        runHub: async () => {
          throw new Error("injected Hub startup failure");
        },
      },
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "injected Hub startup failure");
    assert.equal(
      failed.assertions.some((assertion: { status: string }) => assertion.status === "failed"),
      false,
    );
    assert.deepEqual(
      failed.assertions.map((assertion: { id: string }) => assertion.id),
      ["product-identity", "cleanup"],
    );
    assert.equal(children.size, 0);
  } finally {
    for (const child of children) await stopProcess(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("validateReport rejects an overall value not derived from contract assertions and cleanup", () => {
  const contract = {
    releaseGate: {
      requiredPhases: [{ id: "p", assertions: ["a", "cleanup"] }],
      sameVersionPhase: { id: "candidate-same-version", assertions: ["health", "cleanup"] },
      firstSplitReleaseException: { candidateVersion: "0.3.0", baselineVersion: "0.2.1" },
    },
  };
  const report = {
    candidateVersion: "0.4.0",
    baselineVersion: "0.3.0",
    phases: [
      {
        id: "p",
        status: "passed",
        assertions: [
          { id: "a", status: "passed" },
          { id: "cleanup", status: "passed" },
        ],
        cleanup: { status: "passed" },
      },
      {
        id: "candidate-same-version",
        status: "passed",
        assertions: [
          { id: "health", status: "passed" },
          { id: "cleanup", status: "passed" },
        ],
        cleanup: { status: "passed" },
      },
    ],
    overall: "passed",
  };
  assert.doesNotThrow(() => validateReport(contract, report));
  report.phases[0].assertions[0].status = "failed";
  assert.throws(() => validateReport(contract, report), /does not match derived failed/u);
});
