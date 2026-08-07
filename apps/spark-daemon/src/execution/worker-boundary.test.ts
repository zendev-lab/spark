import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const checker = resolve(root, "scripts/check-execution-worker-boundary.mjs");
const entry = resolve(import.meta.dirname, "worker-entry.ts");
const contract = resolve(import.meta.dirname, "contract.ts");

const daemonImports = {
  invocation: resolve(import.meta.dirname, "../store/invocations.ts"),
  sqlite: resolve(import.meta.dirname, "../store/schema.ts"),
  tokenUsage: resolve(import.meta.dirname, "../store/token-usage.ts"),
  taskClaim: resolve(import.meta.dirname, "../task-claims/authority.ts"),
  channel: resolve(import.meta.dirname, "../channels/ingress.ts"),
  humanInteraction: resolve(import.meta.dirname, "../core/human-interactions.ts"),
  session: resolve(import.meta.dirname, "../session-control.ts"),
  adapter: resolve(import.meta.dirname, "adapter.ts"),
} as const;

describe("execution worker import boundary", () => {
  it("allows the production protocol entry and follows its contract dependency", () => {
    expect(execFileSync(process.execPath, [checker, entry], { encoding: "utf8" })).toMatch(
      /Execution worker boundary passed.*2 files, 2 static imports/u,
    );
  });

  it("allows declared host, turn, protocol, contract, and worker-local modules", () => {
    using fixture = workerFixture({
      entry: [
        `import ${JSON.stringify(contract)};`,
        'import "@zendev-lab/spark-host";',
        'import "@zendev-lab/spark-turn";',
        'import "@zendev-lab/spark-protocol/token-usage";',
        'import "./worker/decode.ts";',
      ].join("\n"),
      worker: [
        'export type { SparkJsonValue } from "@zendev-lab/spark-protocol";',
        'export type { SparkTurnResumeCheckpoint } from "@zendev-lab/spark-turn";',
      ].join("\n"),
    });

    expect(execFileSync(process.execPath, [checker, fixture.entry], { encoding: "utf8" })).toMatch(
      /Execution worker boundary passed.*3 files, 8 static imports/u,
    );
  });

  it.each(["node:fs", "node:sqlite", "@zendev-lab/spark-ai", "@zendev-lab/spark-tasks"])(
    "rejects direct runtime or package import %s",
    (specifier) => {
      using fixture = workerFixture({ entry: `import ${JSON.stringify(specifier)};\n` });
      expectViolation(fixture.entry, specifier, "outside the host/turn/protocol allowlist");
    },
  );

  it.each(Object.entries(daemonImports))("rejects direct daemon owner import %s", (_name, path) => {
    using fixture = workerFixture({ entry: `import ${JSON.stringify(path)};\n` });
    expectViolation(fixture.entry, path, "outside contract.ts and worker-local modules");
  });

  it.each(Object.entries(daemonImports))(
    "rejects transitive worker-local daemon owner import %s",
    (_name, path) => {
      using fixture = workerFixture({
        entry: 'import "./worker/decode.ts";\n',
        worker: `export * from ${JSON.stringify(path)};\n`,
      });
      expectViolation(fixture.entry, path, "outside contract.ts and worker-local modules");
    },
  );

  it("rejects a non-literal dynamic import that cannot be audited", () => {
    using fixture = workerFixture({
      entry: 'import "./worker/decode.ts";\n',
      worker: "export const load = (specifier: string) => import(specifier);\n",
    });
    expectViolation(
      fixture.entry,
      "<dynamic module specifier>",
      "dynamic module specifier is not statically auditable",
    );
  });

  it("rejects a transitive dynamic daemon import", () => {
    using fixture = workerFixture({
      entry: 'import "./worker/decode.ts";\n',
      worker: `export const load = () => import(${JSON.stringify(daemonImports.tokenUsage)});\n`,
    });
    expectViolation(
      fixture.entry,
      daemonImports.tokenUsage,
      "outside contract.ts and worker-local modules",
    );
  });
});

function workerFixture(input: { entry: string; worker?: string }): {
  entry: string;
  [Symbol.dispose](): void;
} {
  const directory = mkdtempSync(join(tmpdir(), "spark-worker-boundary-"));
  const workerDirectory = join(directory, "worker");
  mkdirSync(workerDirectory);
  const fixtureEntry = join(directory, "worker-entry.ts");
  writeFileSync(fixtureEntry, input.entry, "utf8");
  if (input.worker !== undefined) {
    writeFileSync(join(workerDirectory, "decode.ts"), input.worker, "utf8");
  }
  return {
    entry: fixtureEntry,
    [Symbol.dispose]() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function expectViolation(entryPath: string, specifier: string, reason: string): void {
  const result = spawnSync(process.execPath, [checker, entryPath], { encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`forbidden import: ${specifier}`);
  expect(result.stderr).toContain(reason);
}
