import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { test } from "vitest";

const execFileAsync = promisify(execFile);
const fixture = resolve("test/fixtures/repro/minimal-alignment");

test("minimal Repro fixture fails before repair and passes after one explicit change", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "spark-repro-golden-fixture-"));
  const workspace = join(temporary, "minimal-alignment");
  await cp(fixture, workspace, { recursive: true });

  try {
    const reference = await verify(workspace, "reference");
    assert.match(reference.stdout, /^PASS reference 4 vectors\n$/u);
    assert.equal(reference.stderr, "");

    const targetFailure = await verificationFailure(workspace, "target");
    assert.equal(targetFailure.code, 1);
    assert.match(
      `${targetFailure.stdout ?? ""}\n${targetFailure.stderr ?? ""}`,
      /FAIL target [1-4]\/4 vectors/u,
    );

    await copyFile(
      join(workspace, "reference", "normalize.mjs"),
      join(workspace, "target", "normalize.mjs"),
    );

    const repaired = await verify(workspace, "target");
    assert.match(repaired.stdout, /^PASS target 4 vectors\n$/u);
    assert.equal(repaired.stderr, "");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 30_000);

function verify(cwd: string, implementation: "reference" | "target") {
  return execFileAsync(process.execPath, [join(cwd, "verify.mjs"), implementation], {
    cwd,
    env: process.env,
    encoding: "utf8",
  });
}

async function verificationFailure(cwd: string, implementation: "reference" | "target") {
  try {
    await verify(cwd, implementation);
  } catch (error) {
    return error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
  }
  throw new Error(`${implementation} verification unexpectedly passed`);
}
