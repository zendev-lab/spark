import assert from "node:assert/strict";
import { test } from "vitest";

import plugin, {
  apply,
  inject,
  installRandomUuidPolyfill,
  isOAuthProvider,
  name,
  providerApiKeyRef,
  providerOnboardingMessages,
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

test("ships balanced English and Chinese onboarding dictionaries", () => {
  assert.deepEqual(
    Object.keys(providerOnboardingMessages.en),
    Object.keys(providerOnboardingMessages.zh),
  );
  assert.equal(providerOnboardingMessages.en.title, "Choose and configure a provider");
  assert.equal(providerOnboardingMessages.zh.title, "选择 Provider 并配置");
});

test("maps DSH provider routes onto API-key and OAuth credential flows", () => {
  assert.equal(providerApiKeyRef("baidu-oneapi"), "BAIDU_ONEAPI_API_KEY");
  assert.equal(providerApiKeyRef("kimi-coding"), "KIMI_API_KEY");
  assert.equal(providerApiKeyRef("openai-codex"), undefined);
  assert.equal(isOAuthProvider("openai-codex"), true);
  assert.equal(isOAuthProvider("kimi-coding"), false);
});

test("registers the onboarding locale namespace with the DSH slot", () => {
  const calls: unknown[] = [];
  const component = Symbol("component");
  const ctx = {
    locale: {
      register(namespace: string, dictionaries: typeof providerOnboardingMessages) {
        calls.push(["locale", namespace, dictionaries]);
        return () => undefined;
      },
    },
    slots: {
      inject(slot: string, register: () => unknown) {
        calls.push(["inject", slot]);
        register();
      },
      register(options: unknown, receivedComponent: unknown) {
        calls.push(["register", options]);
        assert.notEqual(receivedComponent, component);
        return component;
      },
    },
    connection: { api: {} },
  };

  apply(ctx as never);

  assert.deepEqual(calls[0], ["locale", "spark.provider-onboarding", providerOnboardingMessages]);
  assert.equal((calls[2] as [string, { locale: string }])[1].locale, "spark.provider-onboarding");
});
