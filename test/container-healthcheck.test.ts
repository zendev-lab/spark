import assert from "node:assert/strict";
import { test } from "vitest";
import {
  checkCockpitHealth,
  createCockpitHealthcheckRequest,
} from "../scripts/container-healthcheck.mjs";

test("container healthcheck uses the configured port without proxy headers", () => {
  const request = createCockpitHealthcheckRequest({ PORT: "6173" });

  assert.equal(request.url.href, "http://127.0.0.1:6173/api/v1/health");
  assert.deepEqual(request.headers, {});
});

test("container healthcheck represents the trusted public proxy", () => {
  const request = createCockpitHealthcheckRequest({
    PORT: "5173",
    SPARK_COCKPIT_PUBLIC_URL: "https://spark.example.test",
    SPARK_COCKPIT_TRUST_PROXY: "loopback",
    SPARK_COCKPIT_PROXY_HOPS: "2",
  });

  assert.deepEqual(request.headers, {
    host: "spark.example.test",
    "x-forwarded-for": "127.0.0.1, 127.0.0.1",
    "x-forwarded-proto": "https",
  });
});

test("container healthcheck validates the Cockpit health response", async () => {
  const healthy = await checkCockpitHealth({}, async (input) => {
    assert.ok(input instanceof URL);
    assert.equal(input.href, "http://127.0.0.1:5173/api/v1/health");
    return Response.json({ service: "spark-cockpit", status: "ok" });
  });

  assert.equal(healthy, true);
});
