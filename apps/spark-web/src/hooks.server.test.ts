import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

import { isHttpError, isRedirect, type Handle } from "@sveltejs/kit";

import { handle } from "./hooks.server.ts";
import {
  setSparkWebTokenVerifier,
  SPARK_WEB_BIND_HOST_ENV,
  SPARK_WEB_BIND_PORT_ENV,
} from "./lib/server/auth.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  setSparkWebTokenVerifier();
});

test("loopback peers require a token even when the listener binds all interfaces", async () => {
  for (const bindHost of ["127.0.0.1", "0.0.0.0"]) {
    stubTrust(bindHost);
    const { response } = await runHandle({
      url: "http://127.0.0.1:4310/",
      clientAddress: "::ffff:127.0.0.1",
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 200, bindHost);
    assert.match(await response.text(), /Connect to this daemon/u, bindHost);
  }
});

test("read-only Local Share capability URLs stay outside workbench token auth", async () => {
  stubTrust("127.0.0.1");
  setSparkWebTokenVerifier(async () => "invalid");
  const { response } = await runHandle({
    url: "http://127.0.0.1:4310/share/abcdefghijklmnopqrstuvwxyzABCDEF",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("document navigation receives the shared access page instead of a raw 401", async () => {
  stubTrust("10.0.0.2");
  const { response } = await runHandle({
    url: "http://10.0.0.2:4310/",
    clientAddress: "10.0.0.9",
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Connect to this daemon/u);
  assert.match(html, /spark daemon access create/u);
  assert.match(html, /name="token"/u);
});

test("API requests without a token keep the carrier-level 401", async () => {
  stubTrust("10.0.0.2");
  await assert.rejects(
    () =>
      runHandle({
        url: "http://10.0.0.2:4310/api/v1/rpc",
        clientAddress: "10.0.0.9",
      }),
    (error: unknown) => isHttpError(error, 401),
  );
});

test("access form verifies with the daemon, sets the HttpOnly carrier cookie, and returns", async () => {
  stubTrust("10.0.0.2");
  setSparkWebTokenVerifier(async (token) => (token === "sdu_good" ? "valid" : "invalid"));
  const cookieSet = vi.fn();

  await assert.rejects(
    () =>
      runHandle({
        url: "http://10.0.0.2:4310/__spark/access",
        method: "POST",
        body: "token=sdu_good&returnTo=%2Fsessions%2Fsess_1",
        clientAddress: "10.0.0.9",
        cookieSet,
        headers: {
          origin: "http://10.0.0.2:4310",
          "content-type": "application/x-www-form-urlencoded",
          "sec-fetch-site": "same-origin",
        },
      }),
    (error: unknown) => {
      if (!isRedirect(error)) return false;
      assert.equal(error.status, 303);
      assert.equal(error.location, "/sessions/sess_1");
      return true;
    },
  );
  assert.equal(cookieSet.mock.calls[0]?.[1], "sdu_good");
  assert.equal(cookieSet.mock.calls[0]?.[2]?.httpOnly, true);
  assert.equal(cookieSet.mock.calls[0]?.[2]?.sameSite, "lax");
  assert.equal(cookieSet.mock.calls[0]?.[2]?.secure, false);
});

test("invalid and unavailable access tokens stay on the shared access page", async () => {
  stubTrust("10.0.0.2");
  setSparkWebTokenVerifier(async () => "invalid");
  const invalid = await runHandle({
    url: "http://10.0.0.2:4310/__spark/access",
    method: "POST",
    body: "token=sdu_bad&returnTo=%2F",
    clientAddress: "10.0.0.9",
    headers: {
      origin: "http://10.0.0.2:4310",
      "content-type": "application/x-www-form-urlencoded",
      "sec-fetch-site": "same-origin",
    },
  });
  assert.equal(invalid.response.status, 401);
  assert.match(await invalid.response.text(), /Invalid access token/u);

  setSparkWebTokenVerifier(async () => "unavailable");
  const unavailable = await runHandle({
    url: "http://10.0.0.2:4310/",
    clientAddress: "10.0.0.9",
    cookie: "sdu_good",
    headers: { accept: "text/html" },
  });
  assert.equal(unavailable.response.status, 503);
  assert.match(await unavailable.response.text(), /daemon is unavailable/u);
});

test("verified query tokens remain a navigation-only compatibility carrier", async () => {
  stubTrust("10.0.0.2");
  setSparkWebTokenVerifier(async (token) => (token === "sdu_good" ? "valid" : "invalid"));
  const cookieSet = vi.fn();
  await assert.rejects(
    () =>
      runHandle({
        url: "http://10.0.0.2:4310/?token=sdu_good&lang=en",
        clientAddress: "10.0.0.9",
        cookieSet,
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      }),
    (error: unknown) => {
      if (!isRedirect(error)) return false;
      assert.equal(error.status, 303);
      assert.equal(error.location, "/?lang=en");
      return true;
    },
  );
  assert.equal(cookieSet.mock.calls[0]?.[1], "sdu_good");
  assert.equal(cookieSet.mock.calls[0]?.[2]?.sameSite, "lax");

  await assert.rejects(
    () =>
      runHandle({
        url: "http://10.0.0.2:4310/api/v1/rpc?token=sdu_good",
        method: "POST",
        clientAddress: "10.0.0.9",
        headers: { origin: "http://10.0.0.2:4310" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

test("a remote peer cannot spoof a loopback Host to bypass authentication", async () => {
  stubTrust("0.0.0.0");
  setSparkWebTokenVerifier(async () => "valid");
  await assert.rejects(
    () =>
      runHandle({
        url: "http://127.0.0.1:4310/",
        clientAddress: "10.0.0.9",
        headers: { "x-spark-web-token": "sdu_good" },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

test("forged Origin and cross-site requests remain rejected before authentication", async () => {
  stubTrust("10.0.0.2");
  setSparkWebTokenVerifier(async () => "valid");
  await assert.rejects(
    () =>
      runHandle({
        url: "http://10.0.0.2:4310/",
        clientAddress: "10.0.0.9",
        headers: {
          origin: "http://evil.test",
          "x-spark-web-token": "sdu_good",
        },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
  await assert.rejects(
    () =>
      runHandle({
        url: "http://10.0.0.2:4310/",
        clientAddress: "10.0.0.9",
        headers: {
          "sec-fetch-site": "cross-site",
          "x-spark-web-token": "sdu_good",
        },
      }),
    (error: unknown) => isHttpError(error, 403),
  );
});

function stubTrust(bindHost: string): void {
  vi.stubEnv(SPARK_WEB_BIND_HOST_ENV, bindHost);
  vi.stubEnv(SPARK_WEB_BIND_PORT_ENV, "4310");
}

async function runHandle(input: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  cookie?: string;
  cookieSet?: ReturnType<typeof vi.fn>;
  clientAddress?: string;
}): Promise<{ response: Response }> {
  const url = new URL(input.url);
  const request = new Request(url, {
    method: input.method,
    headers: { host: url.host, ...input.headers },
    body: input.body,
  });
  const response = await handle({
    event: {
      cookies: {
        get: (name: string) => (name === "spark_web_token" ? input.cookie : undefined),
        set: input.cookieSet ?? vi.fn(),
      },
      getClientAddress: () => input.clientAddress ?? "127.0.0.1",
      locals: {},
      request,
      url,
    } as never,
    resolve: async () => new Response("ok"),
  } satisfies Parameters<Handle>[0]);
  return { response };
}
