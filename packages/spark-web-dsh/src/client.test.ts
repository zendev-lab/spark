import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "vitest";

import plugin, {
  inject,
  installRandomUuidPolyfill,
  isCredentialsAccessDenied,
  name,
} from "./client.tsx";

test("spark-web-dsh client plugin exposes the onboarding registration shape", () => {
  assert.equal(name, "spark-web-dsh");
  assert.deepEqual(inject, ["slots", "locale", "connection", "remote"]);
  assert.equal(typeof plugin.apply, "function");
});

test("installs a UUID-v4 fallback when randomUUID is unavailable", () => {
  const cryptoApi = {
    getRandomValues(bytes: Uint8Array) {
      bytes.set(Array.from({ length: 16 }, (_, index) => index));
      return bytes;
    },
  } as unknown as Crypto;

  installRandomUuidPolyfill(cryptoApi);

  assert.equal(cryptoApi.randomUUID(), "00010203-0405-4607-8809-0a0b0c0d0e0f");
});
test("recognizes the loopback-only credentials rejection returned to remote browsers", () => {
  assert.equal(
    isCredentialsAccessDenied(
      new Error("transport failure for /api/credentials.describe: HTTP 403"),
    ),
    true,
  );
  assert.equal(isCredentialsAccessDenied(new Error("HTTP 500")), false);
});

test("generated client bundle returns an applicable plugin from its loader factory", () => {
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  let entry: { factory: (require: (id: string) => unknown) => unknown } | undefined;

  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(value: typeof entry) {
          entry = value;
        },
      },
    },
  });

  assert.ok(entry);
  const loaded = entry.factory(() => ({})) as {
    apply?: unknown;
    default?: { apply?: unknown };
  };
  assert.equal(typeof loaded.apply, "function");
  assert.equal(typeof loaded.default?.apply, "function");
});
