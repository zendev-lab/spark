import assert from "node:assert/strict";
import { test } from "vitest";

import {
  inspectCueCommandContract,
  type CueCommandRunner,
  type CueCommandSpec,
  type CueProcessResult,
} from "./command-contract.ts";

function result(
  spec: CueCommandSpec,
  options: {
    code?: number | null;
    stdout?: string;
    stderr?: string;
    error?: CueProcessResult["error"];
    path?: string;
  } = {},
): CueProcessResult {
  return {
    command: spec.command,
    args: spec.args,
    executablePath: options.path ?? `/fixture/bin/${spec.command}`,
    code: options.code === undefined ? 0 : options.code,
    signal: null,
    stdout: options.stdout ?? "",
    stderr: options.stderr ?? "",
    ...(options.error ? { error: options.error } : {}),
  };
}

function missing(spec: CueCommandSpec): CueProcessResult {
  return result(spec, {
    code: null,
    path: undefined,
    error: { code: "ENOENT", message: `spawn ${spec.command} ENOENT` },
  });
}

function fixtureRunner(
  handler: (spec: CueCommandSpec) => CueProcessResult,
  calls: string[],
): CueCommandRunner {
  return async (spec) => {
    calls.push([spec.command, ...spec.args].join(" "));
    return handler(spec);
  };
}

test("cue command contract selects matching aggregate namespaces without probing direct commands", async () => {
  const calls: string[] = [];
  const inspection = await inspectCueCommandContract({
    runner: fixtureRunner((spec) => {
      const invocation = [spec.command, ...spec.args].join(" ");
      if (invocation === "cue --version") return result(spec, { stdout: "cue 0.1.0\n" });
      if (invocation === "cue client --version") {
        return result(spec, { stdout: "cue-client 0.1.0\n" });
      }
      if (invocation === "cue daemon --version") {
        return result(spec, { stdout: "Version: 0.1.0\n" });
      }
      throw new Error(`unexpected probe ${invocation}`);
    }, calls),
  });

  assert.equal(inspection.status, "aggregate");
  assert.deepEqual(inspection.contract, {
    status: "aggregate",
    version: "0.1.0",
    client: { command: "cue", args: ["client"] },
    daemon: { command: "cue", args: ["daemon"] },
  });
  assert.deepEqual(calls, ["cue --version", "cue client --version", "cue daemon --version"]);
});

test("cue command contract selects a complete matching legacy direct command set", async () => {
  const calls: string[] = [];
  const inspection = await inspectCueCommandContract({
    runner: fixtureRunner((spec) => {
      const invocation = [spec.command, ...spec.args].join(" ");
      if (invocation === "cue --version") return missing(spec);
      if (invocation === "cue-client --version") {
        return result(spec, { stdout: "cue-client 0.1.0\n" });
      }
      if (invocation === "cued --version") return result(spec, { stdout: "Version: 0.1.0\n" });
      throw new Error(`unexpected probe ${invocation}`);
    }, calls),
  });

  assert.equal(inspection.status, "legacy-direct");
  assert.deepEqual(inspection.contract, {
    status: "legacy-direct",
    version: "0.1.0",
    client: { command: "cue-client", args: [] },
    daemon: { command: "cued", args: [] },
  });
  assert.deepEqual(calls, ["cue --version", "cue-client --version", "cued --version"]);
});

test("foreign cue may coexist with a complete legacy cue-shell command set", async () => {
  const calls: string[] = [];
  const inspection = await inspectCueCommandContract({
    runner: fixtureRunner((spec) => {
      const invocation = [spec.command, ...spec.args].join(" ");
      if (invocation === "cue --version") {
        return result(spec, { stdout: "cue version v0.14.0 linux/amd64\n" });
      }
      if (invocation === "cue-client --version") {
        return result(spec, { stdout: "cue-client 0.1.0\n" });
      }
      if (invocation === "cued --version") return result(spec, { stdout: "Version: 0.1.0\n" });
      throw new Error(`unexpected probe ${invocation}`);
    }, calls),
  });

  assert.equal(inspection.status, "legacy-direct");
  assert.match(inspection.message, /not the cue-shell aggregate CLI/u);
  assert.deepEqual(calls, ["cue --version", "cue-client --version", "cued --version"]);
});

test("recognized aggregate with missing or mismatched namespaces never falls back", async () => {
  for (const broken of ["client", "daemon", "version-mismatch"] as const) {
    const calls: string[] = [];
    const inspection = await inspectCueCommandContract({
      runner: fixtureRunner((spec) => {
        const invocation = [spec.command, ...spec.args].join(" ");
        if (invocation === "cue --version") return result(spec, { stdout: "cue 0.1.0\n" });
        if (invocation === "cue client --version") {
          if (broken === "client") return result(spec, { code: 9, stderr: "missing client" });
          return result(spec, { stdout: "cue-client 0.1.0\n" });
        }
        if (invocation === "cue daemon --version") {
          if (broken === "daemon") return result(spec, { code: 11, stderr: "missing daemon" });
          return result(spec, {
            stdout: broken === "version-mismatch" ? "Version: 0.2.0\n" : "Version: 0.1.0\n",
          });
        }
        throw new Error(`direct fallback must not be probed: ${invocation}`);
      }, calls),
    });

    assert.equal(inspection.status, "incomplete-installation", broken);
    assert.deepEqual(
      calls,
      ["cue --version", "cue client --version", "cue daemon --version"],
      broken,
    );
    assert.match(inspection.message, /uv tool install --reinstall cue-shell/u);
  }
});

test("foreign, incomplete, and missing diagnostics carry distinct paths and recovery", async () => {
  const scenarios = [
    {
      expected: "foreign",
      cue: "cue version v0.14.0 linux/amd64\n",
      client: missing,
      daemon: missing,
      pattern: /not the cue-shell aggregate CLI/u,
    },
    {
      expected: "incomplete-installation",
      cue: undefined,
      client: (spec: CueCommandSpec) => result(spec, { stdout: "cue-client 0.1.0\n" }),
      daemon: missing,
      pattern: /installation is incomplete/u,
    },
    {
      expected: "missing",
      cue: undefined,
      client: missing,
      daemon: missing,
      pattern: /required for command execution but was not found/u,
    },
  ] as const;

  for (const scenario of scenarios) {
    const inspection = await inspectCueCommandContract({
      runner: async (spec) => {
        if (spec.command === "cue") {
          return scenario.cue ? result(spec, { stdout: scenario.cue }) : missing(spec);
        }
        if (spec.command === "cue-client") return scenario.client(spec);
        return scenario.daemon(spec);
      },
    });
    assert.equal(inspection.status, scenario.expected);
    assert.match(inspection.message, scenario.pattern);
    assert.match(inspection.message, /\/fixture\/bin\/(?:cue|cue-client|cued)|not found on PATH/u);
    assert.match(inspection.message, /uv tool install/u);
  }
});
