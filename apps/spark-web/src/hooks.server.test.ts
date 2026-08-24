import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { isHttpError, isRedirect, type Handle } from "@sveltejs/kit";

import { handle } from "./hooks.server.ts";
import {
  setSparkWebTokenVerifier,
  SPARK_WEB_BIND_HOST_ENV,
  SPARK_WEB_BIND_PORT_ENV,
  SPARK_WEB_TRUSTED_HOSTS_ENV,
} from "./lib/server/auth.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  setSparkWebTokenVerifier();
});

test("loopback IPv4 and IPv6 listeners do not require a token", async () => {
  for (const bindHost of ["127.0.0.1", "::1", "localhost"]) {
    stubTrust({ bindHost });
    const { response } = await runHandle({ url: "http://127.0.0.1:4310/" });
    assert.equal(response.status, 200, bindHost);
  }
});

test("tokenless loopback mutations still require same-origin provenance", async () => {
  stubTrust({ bindHost: "127.0.0.1" });

  const accepted = await runHandle({
    url: "http://127.0.0.1:4310/api/v1/rpc",
    method: "POST",
    headers: { origin: "http://127.0.0.1:4310" },
  });
  assert.equal(accepted.response.status, 200);

  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/api/v1/rpc",
        method: "POST",
      }),
    (error: unknown) => isHttpError(error, 403),
  );

  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/api/v1/rpc",
        method: "POST",
        headers: { "x-spark-web-token": "stale" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

test("loopback query tokens remain navigation-only", async () => {
  stubTrust({ bindHost: "127.0.0.1" });

  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/api/v1/rpc?token=stale",
        method: "POST",
        headers: { origin: "http://127.0.0.1:4310" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

test("loopback navigation removes stale query tokens without setting a cookie", async () => {
  stubTrust({ bindHost: "127.0.0.1" });
  const cookieSet = vi.fn();

  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/?token=stale&lang=zh",
        cookieSet,
      }),
    (error: unknown) => {
      assert.equal(isRedirect(error), true);
      if (!isRedirect(error)) return false;
      assert.equal(error.status, 303);
      assert.equal(error.location, "/?lang=zh");
      return true;
    },
  );
  assert.equal(cookieSet.mock.calls.length, 0);
});

test("non-loopback listeners reject missing and daemon-rejected tokens", async () => {
  stubTrust({ bindHost: "0.0.0.0", trustedHosts: "spark.lan" });
  setSparkWebTokenVerifier(async () => "invalid");

  await assert.rejects(
    () => runHandle({ url: "http://spark.lan:4310/" }),
    (error: unknown) => isHttpError(error, 401),
  );
  // Wrong, expired, and revoked tokens all surface as the daemon's denial.
  await assert.rejects(
    () =>
      runHandle({
        url: "http://spark.lan:4310/",
        headers: { "x-spark-web-token": "sdu_expired" },
      }),
    (error: unknown) => isHttpError(error, 401),
  );
  await assert.rejects(
    () => runHandle({ url: "http://spark.lan:4310/", cookie: "sdu_revoked" }),
    (error: unknown) => isHttpError(error, 401),
  );
});

test("non-loopback listeners accept a daemon-verified token and persist it as a cookie", async () => {
  stubTrust({ bindHost: "0.0.0.0", trustedHosts: "spark.lan" });
  const verified: string[] = [];
  setSparkWebTokenVerifier(async (token) => {
    verified.push(token);
    return token === "sdu_good" ? "valid" : "invalid";
  });

  const { response } = await runHandle({
    url: "http://spark.lan:4310/",
    headers: { "x-spark-web-token": "sdu_good" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(verified, ["sdu_good"]);

  const cookieSet = vi.fn();
  await assert.rejects(
    () =>
      runHandle({
        url: "http://spark.lan:4310/?token=sdu_good&lang=en",
        cookieSet,
      }),
    (error: unknown) => {
      if (!isRedirect(error)) return false;
      assert.equal(error.status, 303);
      assert.equal(error.location, "/?lang=en");
      return true;
    },
  );
  assert.equal(cookieSet.mock.calls[0]?.[1], "sdu_good");
});

test("non-loopback listeners fail closed when the daemon is unavailable", async () => {
  stubTrust({ bindHost: "0.0.0.0", trustedHosts: "spark.lan" });
  setSparkWebTokenVerifier(async () => "unavailable");

  await assert.rejects(
    () =>
      runHandle({
        url: "http://spark.lan:4310/",
        headers: { "x-spark-web-token": "sdu_good" },
      }),
    (error: unknown) => isHttpError(error, 503),
  );
});

test("a loopback-looking Host cannot bypass a non-loopback listener boundary", async () => {
  stubTrust({ bindHost: "0.0.0.0", trustedHosts: "spark.lan" });
  setSparkWebTokenVerifier(async () => "valid");

  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/",
        headers: { "x-spark-web-token": "sdu_good" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

test("forged Origin and cross-site requests stay rejected on every listener", async () => {
  stubTrust({ bindHost: "127.0.0.1" });

  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/",
        headers: { origin: "http://evil.test" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );

  stubTrust({ bindHost: "0.0.0.0", trustedHosts: "spark.lan" });
  setSparkWebTokenVerifier(async () => "valid");
  await assert.rejects(
    () =>
      runHandle({
        url: "http://spark.lan:4310/",
        headers: { origin: "http://evil.test", "x-spark-web-token": "sdu_good" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

function stubTrust(input: { bindHost: string; trustedHosts?: string }): void {
  vi.stubEnv(SPARK_WEB_BIND_HOST_ENV, input.bindHost);
  vi.stubEnv(SPARK_WEB_BIND_PORT_ENV, "4310");
  vi.stubEnv(SPARK_WEB_TRUSTED_HOSTS_ENV, input.trustedHosts ?? "");
}

async function runHandle(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  cookie?: string;
  cookieSet?: ReturnType<typeof vi.fn>;
}): Promise<{ response: Response }> {
  const url = new URL(input.url);
  const request = new Request(url, {
    method: input.method,
    headers: { host: url.host, ...input.headers },
  });
  const response = await handle({
    event: {
      cookies: {
        get: (name: string) => (name === "spark_web_token" ? input.cookie : undefined),
        set: input.cookieSet ?? vi.fn(),
      },
      locals: {},
      request,
      url,
    } as never,
    resolve: async () => new Response("ok"),
  } satisfies Parameters<Handle>[0]);
  return { response };
}
