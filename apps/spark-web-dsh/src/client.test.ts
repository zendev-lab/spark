import assert from "node:assert/strict";
import { test } from "vitest";

import plugin, { inject, installRandomUuidPolyfill, name } from "./client.tsx";

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
