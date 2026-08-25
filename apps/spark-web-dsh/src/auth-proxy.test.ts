import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "vitest";

import {
  isSparkWebDshLoopbackHost,
  startSparkWebDshAuthProxy,
  type SparkWebDshTokenVerifier,
} from "./auth-proxy.ts";

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      resolveListen((server.address() as AddressInfo).port);
    });
  });
}

async function startUpstream(): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url} host=${request.headers.host}`);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("upstream-ok");
  });
  const port = await listenLoopback(server);
  return { server, port, seen };
}

async function startProxy(
  targetPort: number,
  verify: SparkWebDshTokenVerifier,
): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = await startSparkWebDshAuthProxy({
    host: "0.0.0.0",
    port: 0,
    targetPort,
    verify,
  });
  return {
    port: (proxy.server.address() as AddressInfo).port,
    close: () => proxy.close(),
  };
}

test("loopback predicate matches native Spark Web", () => {
  for (const host of ["127.0.0.1", "127.10.20.30", "::1", "[::1]", "localhost", "LOCALHOST"]) {
    assert.equal(isSparkWebDshLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "spark.lan", "10.0.0.2", "::ffff:127.0.0.1"]) {
    assert.equal(isSparkWebDshLoopbackHost(host), false, host);
  }
});

test("proxy rejects missing and daemon-rejected tokens with one undifferentiated 401", async () => {
  const upstream = await startUpstream();
  const verified: string[] = [];
  const proxy = await startProxy(upstream.port, async (token) => {
    verified.push(token);
    return token === "sdu_good" ? "valid" : "invalid";
  });
  try {
    const missing = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(missing.status, 401);
    assert.deepEqual(verified, []);

    for (const rejected of ["sdu_wrong", "sdu_expired", "sdu_revoked"]) {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/`, {
        headers: { "x-spark-web-token": rejected },
      });
      assert.equal(response.status, 401, rejected);
    }
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("proxy fails closed with 503 when the daemon is unavailable", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async () => "unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { "x-spark-web-token": "sdu_good" },
    });
    assert.equal(response.status, 503);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("proxy forwards authenticated requests and promotes query tokens to cookies", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async (token) =>
    token === "sdu_good" ? "valid" : "invalid",
  );
  try {
    const headerAuth = await fetch(`http://127.0.0.1:${proxy.port}/api/sessions`, {
      headers: { "x-spark-web-token": "sdu_good" },
    });
    assert.equal(headerAuth.status, 200);
    assert.equal(await headerAuth.text(), "upstream-ok");

    const cookieAuth = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { cookie: "spark_web_token=sdu_good" },
    });
    assert.equal(cookieAuth.status, 200);

    const navigation = await fetch(`http://127.0.0.1:${proxy.port}/?token=sdu_good&lang=zh`, {
      redirect: "manual",
    });
    assert.equal(navigation.status, 303);
    assert.equal(navigation.headers.get("location"), "/?lang=zh");
    const cookie = navigation.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^spark_web_token=sdu_good/u);
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /SameSite=Strict/u);

    assert.deepEqual(upstream.seen, [
      `GET /api/sessions host=127.0.0.1:${proxy.port}`,
      `GET / host=127.0.0.1:${proxy.port}`,
    ]);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("query tokens are navigation-only on the proxy", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async () => "valid");
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/rpc?token=sdu_good`, {
      method: "POST",
    });
    assert.equal(response.status, 403);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});
