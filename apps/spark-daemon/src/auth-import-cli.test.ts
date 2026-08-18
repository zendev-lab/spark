import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createSparkProviderControl } from "@zendev-lab/spark-llm/control";

import { main, type CliIo } from "./cli.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function withCliHome(
  fn: (input: {
    sparkHome: string;
    piDir: string;
    io: CliIo;
    stdout: () => string;
    stderr: () => string;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "spark-auth-import-cli-"));
  const sparkHome = join(root, "spark");
  const piDir = join(root, "pi");
  let out = "";
  let err = "";
  vi.stubEnv("SPARK_HOME", sparkHome);
  vi.stubEnv("PI_CODING_AGENT_DIR", piDir);
  try {
    await fn({
      sparkHome,
      piDir,
      io: {
        stdout: { write: (value) => ((out += String(value)), true) },
        stderr: { write: (value) => ((err += String(value)), true) },
        providerAuthImportPiInService: async (_paths, input) =>
          await createSparkProviderControl().importPiAuth(input),
      },
      stdout: () => out,
      stderr: () => err,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("daemon auth import pi writes a secret-free JSON report", async () => {
  await withCliHome(async ({ sparkHome, piDir, io, stdout, stderr }) => {
    await mkdir(piDir, { recursive: true });
    await writeFile(
      join(piDir, "auth.json"),
      `${JSON.stringify({
        "openai-codex": {
          type: "oauth",
          refresh: "refresh-cli-fixture",
          access: "access-cli-fixture",
          expires: 9_999_999_999_999,
          accountId: "account-cli-fixture",
        },
        "baidu-oneapi": { type: "api_key", key: "$BAIDU_ONEAPI_API_KEY" },
      })}\n`,
    );

    assert.equal(await main(["auth", "import", "pi", "--json"], io), 0);
    assert.equal(stderr(), "");
    const report = JSON.parse(stdout()) as {
      imported: Array<{ provider: string; type: string }>;
      skipped: Array<{ provider: string; reason: string }>;
    };
    assert.deepEqual(report.imported, [{ provider: "openai-codex", type: "oauth" }]);
    assert.deepEqual(report.skipped, [
      { provider: "baidu-oneapi", type: "api_key", reason: "dynamic_reference_unsupported" },
    ]);
    assert.doesNotMatch(stdout(), /refresh-cli-fixture|access-cli-fixture/u);

    const persisted = await readFile(join(sparkHome, "auth.json"), "utf8");
    assert.match(persisted, /account-cli-fixture/u);
  });
});

test("daemon auth import pi uses stable usage and failure exit codes", async () => {
  await withCliHome(async ({ io, stderr }) => {
    assert.equal(await main(["auth", "import", "other"], io), 2);
    assert.match(stderr(), /Usage: spark daemon auth <status\|login\|logout\|import>/u);
  });
  await withCliHome(async ({ io, stderr }) => {
    assert.equal(await main(["auth", "import", "pi", "--json"], io), 1);
    const failure = JSON.parse(stderr()) as { error: { code: string; message: string } };
    assert.equal(failure.error.code, "AUTH_IMPORT_FAILED");
    assert.match(failure.error.message, /Pi auth file was not found/u);
  });
});

test("daemon auth import pi redacts unreadable Spark store details", async () => {
  await withCliHome(async ({ sparkHome, piDir, io, stdout, stderr }) => {
    await mkdir(piDir, { recursive: true });
    await mkdir(sparkHome, { recursive: true });
    await writeFile(
      join(piDir, "auth.json"),
      `${JSON.stringify({
        "openai-codex": {
          type: "oauth",
          refresh: "store-error-refresh-secret",
          access: "store-error-access-secret",
          expires: 9_999_999_999_999,
        },
      })}\n`,
    );
    await writeFile(join(sparkHome, "auth.json"), "{broken-store\n");

    assert.equal(await main(["auth", "import", "pi", "--json"], io), 1);
    assert.equal(stdout(), "");
    const failure = JSON.parse(stderr()) as { error: { message: string } };
    assert.equal(
      failure.error.message,
      "Spark auth store could not be read; no credentials were imported.",
    );
    assert.doesNotMatch(
      stderr(),
      /store-error-refresh-secret|store-error-access-secret|broken-store/u,
    );
    assert.equal(await readFile(join(sparkHome, "auth.json"), "utf8"), "{broken-store\n");
  });
});
