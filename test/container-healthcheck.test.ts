import assert from "node:assert/strict";
import { test } from "vitest";
import { checkHubHealth, createHubHealthcheckRequest } from "../scripts/container-healthcheck.mjs";

test("container healthcheck uses the configured port without proxy headers", () => {
  const request = createHubHealthcheckRequest({ PORT: "6173" });

  assert.equal(request.url.href, "http://127.0.0.1:6173/api/v1/health");
  assert.deepEqual(request.headers, {});
});

test("container healthcheck represents the trusted public proxy", () => {
  const request = createHubHealthcheckRequest({
    PORT: "5173",
    SPARK_HUB_PUBLIC_URL: "https://spark.example.test",
    SPARK_HUB_TRUST_PROXY: "loopback",
    SPARK_HUB_PROXY_HOPS: "2",
  });

  assert.deepEqual(request.headers, {
    host: "spark.example.test",
    "x-forwarded-for": "127.0.0.1, 127.0.0.1",
    "x-forwarded-proto": "https",
  });
});

test("container healthcheck accepts retired Cockpit proxy variables", () => {
  const request = createHubHealthcheckRequest({
    SPARK_COCKPIT_PUBLIC_URL: "https://legacy.example.test",
    SPARK_COCKPIT_TRUST_PROXY: "loopback",
    SPARK_COCKPIT_PROXY_HOPS: "2",
  });

  assert.deepEqual(request.headers, {
    host: "legacy.example.test",
    "x-forwarded-for": "127.0.0.1, 127.0.0.1",
    "x-forwarded-proto": "https",
  });
});

test("container healthcheck fails closed on conflicting Hub and Cockpit variables", () => {
  assert.throws(
    () =>
      createHubHealthcheckRequest({
        SPARK_HUB_PUBLIC_URL: "https://hub.example.test",
        SPARK_COCKPIT_PUBLIC_URL: "https://legacy.example.test",
        SPARK_HUB_TRUST_PROXY: "loopback",
      }),
    /SPARK_HUB_PUBLIC_URL conflicts with retired SPARK_COCKPIT_PUBLIC_URL/u,
  );
});

test("container healthcheck validates the Hub health response", async () => {
  const healthy = await checkHubHealth({}, async (input) => {
    assert.ok(input instanceof URL);
    assert.equal(input.href, "http://127.0.0.1:5173/api/v1/health");
    return Response.json({ service: "spark-hub", status: "ok" });
  });

  assert.equal(healthy, true);
});
