import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  SparkAuthStore,
  importPiAuth,
  resolvePiAuthSourcePath,
  type SparkAuthImportTarget,
} from "@zendev-lab/spark-ai/control";

async function withImportDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-pi-auth-import-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const targets: SparkAuthImportTarget[] = [
  {
    providerName: "oauth-provider",
    credentialProvider: "oauth-storage",
    authKind: "oauth",
  },
  {
    providerName: "api-provider",
    credentialProvider: "api-provider",
    authKind: "api_key",
  },
  {
    providerName: "dynamic-provider",
    credentialProvider: "dynamic-provider",
    authKind: "api_key",
  },
  {
    providerName: "dynamic-oauth-provider",
    credentialProvider: "dynamic-oauth-provider",
    authKind: "oauth",
  },
  {
    providerName: "env-only-provider",
    credentialProvider: "env-only-provider",
    authKind: "api_key",
  },
  {
    providerName: "mismatch-provider",
    credentialProvider: "mismatch-provider",
    authKind: "oauth",
  },
  {
    providerName: "invalid-provider",
    credentialProvider: "invalid-provider",
    authKind: "api_key",
  },
];

test("resolvePiAuthSourcePath follows Pi directory precedence without evaluating credentials", () => {
  assert.equal(
    resolvePiAuthSourcePath({ PI_CODING_AGENT_DIR: "/tmp/pi-fixture" }, "/home/fixture"),
    "/tmp/pi-fixture/auth.json",
  );
  assert.equal(resolvePiAuthSourcePath({}, "/home/fixture"), "/home/fixture/.pi/agent/auth.json");
});

test("Pi auth import is selective, atomic, permission-safe, and secret-free", async () => {
  await withImportDir(async (dir) => {
    const sourcePath = join(dir, "pi-auth.json");
    const authPath = join(dir, "spark", "auth.json");
    await writeFile(
      sourcePath,
      `${JSON.stringify({
        "oauth-provider": {
          type: "oauth",
          refresh: "refresh-fixture-secret",
          access: "access-fixture-secret",
          expires: 9_999_999,
          accountId: "account-fixture",
        },
        "api-provider": { type: "api_key", key: "literal-fixture-secret" },
        "dynamic-provider": { type: "api_key", key: "!security find-generic-password" },
        "dynamic-oauth-provider": {
          type: "oauth",
          refresh: "${OAUTH_REFRESH}",
          access: "access-fixture-secret",
          expires: 9_999_999,
        },
        "env-only-provider": { type: "api_key", env: "ENV_ONLY_SECRET" },
        "mismatch-provider": { type: "api_key", key: "wrong-kind-secret" },
        "invalid-provider": { type: "api_key" },
        "unknown-provider": { type: "api_key", key: "$UNKNOWN_SECRET" },
      })}\n`,
    );
    const store = new SparkAuthStore({
      path: authPath,
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    });

    const report = await importPiAuth({
      sourcePath,
      store,
      targets,
      homeDir: dir,
    });

    assert.deepEqual(report.imported, [
      { provider: "oauth-provider", type: "oauth" },
      { provider: "api-provider", type: "api_key" },
    ]);
    assert.deepEqual(report.overwritten, []);
    assert.deepEqual(
      report.skipped.map(({ provider, reason }) => ({ provider, reason })),
      [
        { provider: "dynamic-provider", reason: "dynamic_reference_unsupported" },
        { provider: "dynamic-oauth-provider", reason: "dynamic_reference_unsupported" },
        { provider: "env-only-provider", reason: "dynamic_reference_unsupported" },
        { provider: "mismatch-provider", reason: "auth_kind_mismatch" },
        { provider: "invalid-provider", reason: "invalid_credential" },
        { provider: "unknown-provider", reason: "unsupported_provider" },
      ],
    );
    assert.equal(report.sourcePath, "~/pi-auth.json");
    assert.doesNotMatch(
      JSON.stringify(report),
      /refresh-fixture-secret|access-fixture-secret|literal-fixture-secret|wrong-kind-secret/u,
    );

    await store.reload();
    const oauth = store.get("oauth-storage");
    assert.equal(oauth?.type, "oauth");
    if (oauth?.type === "oauth") {
      assert.equal(oauth.credentials.accountId, "account-fixture");
    }
    assert.equal(store.get("api-provider")?.type, "api_key");
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "spark"))).mode & 0o777, 0o700);
  });
});

test("Pi auth import preserves existing credentials unless overwrite is explicit", async () => {
  await withImportDir(async (dir) => {
    const sourcePath = join(dir, "auth.json");
    const store = new SparkAuthStore({ path: join(dir, "spark-auth.json") });
    await writeFile(
      sourcePath,
      `${JSON.stringify({ "api-provider": { type: "api_key", key: "new-secret" } })}\n`,
    );
    await store.setApiKey("api-provider", "existing-secret");

    const preserved = await importPiAuth({ sourcePath, store, targets });
    assert.deepEqual(preserved.imported, []);
    assert.deepEqual(preserved.overwritten, []);
    assert.deepEqual(preserved.skipped, [
      { provider: "api-provider", type: "api_key", reason: "existing" },
    ]);
    const preservedCredential = store.get("api-provider");
    assert.equal(
      preservedCredential?.type === "api_key" ? preservedCredential.apiKey : undefined,
      "existing-secret",
    );

    const overwritten = await importPiAuth({ sourcePath, store, targets, overwrite: true });
    assert.deepEqual(overwritten.overwritten, [{ provider: "api-provider", type: "api_key" }]);
    const overwrittenCredential = store.get("api-provider");
    assert.equal(
      overwrittenCredential?.type === "api_key" ? overwrittenCredential.apiKey : undefined,
      "new-secret",
    );
  });
});

test("Pi auth import fails closed for malformed source or target stores", async () => {
  await withImportDir(async (dir) => {
    const sourcePath = join(dir, "pi-auth.json");
    const authPath = join(dir, "spark-auth.json");
    await writeFile(sourcePath, "[]\n");
    const store = new SparkAuthStore({ path: authPath });
    await assert.rejects(
      importPiAuth({ sourcePath, store, targets }),
      /root must be a JSON object/u,
    );

    await writeFile(
      sourcePath,
      `${JSON.stringify({ "api-provider": { type: "api_key", key: "never-written" } })}\n`,
    );
    await writeFile(authPath, "{broken-target\n");
    await assert.rejects(
      importPiAuth({ sourcePath, store, targets }),
      /Refusing to overwrite unreadable Spark auth store/u,
    );
    assert.equal(await readFile(authPath, "utf8"), "{broken-target\n");

    await writeFile(
      sourcePath,
      `${JSON.stringify({ unknown: { type: "api_key", key: "skipped-secret" } })}\n`,
    );
    await assert.rejects(
      importPiAuth({ sourcePath, store, targets }),
      /Refusing to overwrite unreadable Spark auth store/u,
    );
    assert.equal(await readFile(authPath, "utf8"), "{broken-target\n");
  });
});

test("concurrent Pi imports merge through the Spark auth store mutation lock", async () => {
  await withImportDir(async (dir) => {
    const firstSource = join(dir, "first.json");
    const secondSource = join(dir, "second.json");
    const authPath = join(dir, "spark-auth.json");
    await writeFile(
      firstSource,
      `${JSON.stringify({ first: { type: "api_key", key: "first-secret" } })}\n`,
    );
    await writeFile(
      secondSource,
      `${JSON.stringify({ second: { type: "api_key", key: "second-secret" } })}\n`,
    );
    const firstStore = new SparkAuthStore({ path: authPath });
    const secondStore = new SparkAuthStore({ path: authPath });

    await Promise.all([
      importPiAuth({
        sourcePath: firstSource,
        store: firstStore,
        targets: [{ providerName: "first", credentialProvider: "first", authKind: "api_key" }],
      }),
      importPiAuth({
        sourcePath: secondSource,
        store: secondStore,
        targets: [{ providerName: "second", credentialProvider: "second", authKind: "api_key" }],
      }),
    ]);

    const reloaded = new SparkAuthStore({ path: authPath });
    await reloaded.reload();
    assert.deepEqual(reloaded.listProviders(), ["first", "second"]);
  });
});
