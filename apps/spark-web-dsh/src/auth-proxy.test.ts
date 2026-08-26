import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { test } from "vitest";

import {
  isSparkWebDshLoopbackHost,
  normalizeSparkWebDshLanHeaders,
  SPARK_WEB_DSH_TOKEN_HEADER,
  startSparkWebDshAuthProxy,
  type SparkWebDshTokenVerifier,
} from "./auth-proxy.ts";
import { SPARK_WEB_DSH_PROXY_HEADER } from "./private-webserver.ts";

const PRIVATE_PROXY_CREDENTIAL = "test-private-proxy-credential";

function listenLoopback(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      resolveListen((server.address() as AddressInfo).port);
    });
  });
}

async function startUpstream(): Promise<{
  server: Server;
  port: number;
  seen: string[];
  headers: IncomingHttpHeaders[];
}> {
  const seen: string[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url} host=${request.headers.host}`);
    headers.push(request.headers);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("upstream-ok");
  });
  const port = await listenLoopback(server);
  return { server, port, seen, headers };
}

async function startProxy(
  targetPort: number,
  verify: SparkWebDshTokenVerifier,
  remote = true,
): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = await startSparkWebDshAuthProxy({
    host: "0.0.0.0",
    port: 0,
    targetPort,
    proxyCredential: PRIVATE_PROXY_CREDENTIAL,
    verify,
    ...(remote
      ? {
          requiresToken: () => true,
          // Production excludes loopback; tests inject it so a loopback TCP
          // connection can represent a remote LAN request deterministically.
          lanAddresses: ["127.0.0.1"],
        }
      : { lanAddresses: [] }),
  });
  return {
    port: (proxy.server.address() as AddressInfo).port,
    close: () => proxy.close(),
  };
}

test("loopback predicate accepts IPv4-mapped loopback peers", () => {
  for (const host of [
    "127.0.0.1",
    "127.10.20.30",
    "::1",
    "[::1]",
    "localhost",
    "LOCALHOST",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isSparkWebDshLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "spark.lan", "10.0.0.2"]) {
    assert.equal(isSparkWebDshLoopbackHost(host), false, host);
  }
});

test("proxy preserves DSH LAN trust through its loopback target", () => {
  const sameOrigin = normalizeSparkWebDshLanHeaders(
    {
      host: "10.0.0.2:3080",
      origin: "http://10.0.0.2:3080",
      "sec-fetch-site": "same-origin",
    },
    "127.0.0.1",
    3081,
    ["10.0.0.2"],
  );
  assert.equal(sameOrigin.host, "127.0.0.1:3081");
  assert.equal(sameOrigin.origin, "http://127.0.0.1:3081");
  assert.equal(sameOrigin["sec-fetch-site"], "same-origin");

  const crossOrigin = normalizeSparkWebDshLanHeaders(
    {
      host: "10.0.0.2:3080",
      origin: "http://evil.example",
      "sec-fetch-site": "cross-site",
    },
    "127.0.0.1",
    3081,
    ["10.0.0.2"],
  );
  assert.equal(crossOrigin.host, "127.0.0.1:3081");
  assert.equal(crossOrigin.origin, "http://evil.example");
  assert.equal(crossOrigin["sec-fetch-site"], "cross-site");

  const dnsHost = {
    host: "spark.lan:3080",
    origin: "http://spark.lan:3080",
  };
  assert.deepEqual(
    normalizeSparkWebDshLanHeaders(dnsHost, "127.0.0.1", 3081, ["10.0.0.2"]),
    dnsHost,
    "DNS authorities are left for the outer local-IP trust fence to reject",
  );
});

test("loopback peers stay tokenless through an all-interface proxy", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async () => "invalid", false);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "upstream-ok");
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("loopback peers still pass the shared direct-Web trust boundary", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async () => "invalid", false);
  try {
    for (const forged of [
      await rawGet(proxy.port, {}, `evil.example:${proxy.port}`),
      await rawGet(proxy.port, {}, `127.0.0.1:${proxy.port + 1}`),
      await rawGet(proxy.port, {}, `user@127.0.0.1:${proxy.port}`),
      await rawGet(proxy.port, { origin: "https://evil.example" }),
      await rawGet(proxy.port, { "sec-fetch-site": "cross-site" }),
    ]) {
      assert.equal(forged.status, 403);
    }

    const mutationWithoutProvenance = await rawRequest(proxy.port, {
      method: "POST",
      path: "/api/rpc",
    });
    assert.equal(mutationWithoutProvenance.status, 403);

    const sameOriginMutation = await rawRequest(proxy.port, {
      method: "POST",
      path: "/api/rpc",
      headers: {
        origin: `http://127.0.0.1:${proxy.port}`,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(sameOriginMutation.status, 200);

    const forgedUpgrade = await rawRequest(proxy.port, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
      },
      host: `evil.example:${proxy.port}`,
    });
    assert.equal(forgedUpgrade.status, 403);
    assert.deepEqual(upstream.seen, [`POST /api/rpc host=127.0.0.1:${upstream.port}`]);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("remote document navigation gets the shared access page while APIs keep 401", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async () => "invalid");
  try {
    const page = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { accept: "text/html" },
    });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Connect to this daemon/u);

    const api = await fetch(`http://127.0.0.1:${proxy.port}/api/session.list`);
    assert.equal(api.status, 401);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("shared access form verifies with the daemon and promotes the token to a cookie", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async (token) =>
    token === "sdu_good" ? "valid" : "invalid",
  );
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/__spark/access`, {
      method: "POST",
      body: "token=sdu_good&returnTo=%2Fsessions%2Fsess_1",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: `http://127.0.0.1:${proxy.port}`,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "/sessions/sess_1");
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /^spark_web_token=sdu_good/u);
    assert.match(cookie, /HttpOnly/u);
    assert.match(cookie, /SameSite=Strict/u);

    const invalid = await fetch(`http://127.0.0.1:${proxy.port}/__spark/access`, {
      method: "POST",
      body: "token=sdu_bad&returnTo=%2F",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: `http://127.0.0.1:${proxy.port}`,
        "sec-fetch-site": "same-origin",
      },
    });
    assert.equal(invalid.status, 401);
    assert.match(await invalid.text(), /Invalid access token/u);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("proxy fails closed with the shared unavailable page or API 503", async () => {
  const upstream = await startUpstream();
  const proxy = await startProxy(upstream.port, async () => "unavailable");
  try {
    const page = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { accept: "text/html", "x-spark-web-token": "sdu_good" },
    });
    assert.equal(page.status, 503);
    assert.match(await page.text(), /daemon is unavailable/u);

    const api = await fetch(`http://127.0.0.1:${proxy.port}/api/session.list`, {
      headers: { "x-spark-web-token": "sdu_good" },
    });
    assert.equal(api.status, 503);
    assert.equal(upstream.seen.length, 0);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("proxy forwards header/cookie auth and keeps query tokens navigation-only", async () => {
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
      headers: { cookie: "theme=dark; spark_web_token=sdu_good" },
    });
    assert.equal(cookieAuth.status, 200);

    const navigation = await fetch(`http://127.0.0.1:${proxy.port}/?token=sdu_good&lang=zh`, {
      redirect: "manual",
    });
    assert.equal(navigation.status, 303);
    assert.equal(navigation.headers.get("location"), "/?lang=zh");

    const queryMutation = await fetch(`http://127.0.0.1:${proxy.port}/api/rpc?token=sdu_good`, {
      method: "POST",
    });
    assert.equal(queryMutation.status, 403);

    assert.deepEqual(upstream.seen, [
      `GET /api/sessions host=127.0.0.1:${upstream.port}`,
      `GET / host=127.0.0.1:${upstream.port}`,
    ]);
    assert.equal(upstream.headers[0]?.[SPARK_WEB_DSH_PROXY_HEADER], PRIVATE_PROXY_CREDENTIAL);
    assert.equal(upstream.headers[0]?.[SPARK_WEB_DSH_TOKEN_HEADER], undefined);
    assert.equal(upstream.headers[1]?.cookie, "theme=dark");
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

test("DNS and cross-site authorities are rejected before token verification", async () => {
  const upstream = await startUpstream();
  let verified = 0;
  const proxy = await startProxy(upstream.port, async () => {
    verified += 1;
    return "valid";
  });
  try {
    const dns = await rawGet(
      proxy.port,
      { "x-spark-web-token": "sdu_good" },
      `spark.lan:${proxy.port}`,
    );
    assert.equal(dns.status, 403);

    const crossSite = await rawGet(proxy.port, {
      "sec-fetch-site": "cross-site",
      "x-spark-web-token": "sdu_good",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(verified, 0);
  } finally {
    await proxy.close();
    upstream.server.close();
  }
});

/**
 * Raw HTTP/1.1 GET that preserves every header verbatim. `fetch` treats Host
 * and Sec-Fetch-* as forbidden request headers and silently drops them, so
 * forged-authority requests must ride their own TCP socket to reach the
 * proxy's pre-auth trust fence.
 */
function rawGet(
  port: number,
  headers: Record<string, string>,
  host?: string,
): Promise<{ status: number; body: string }> {
  return rawRequest(port, { headers, host });
}

function rawRequest(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    host?: string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolveRaw, rejectRaw) => {
    const socket: Socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      socket.destroy();
      rejectRaw(new Error("raw request timed out"));
    }, 5000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0 || settled) return;
      settled = true;
      clearTimeout(timeout);
      const status = Number(buffer.slice(0, buffer.indexOf("\r\n")).split(" ")[1]);
      socket.destroy();
      resolveRaw({ status, body: buffer.slice(headerEnd + 4) });
    });
    socket.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectRaw(error);
    });
    socket.write(
      [
        `${options.method ?? "GET"} ${options.path ?? "/"} HTTP/1.1`,
        `Host: ${options.host ?? `127.0.0.1:${port}`}`,
        "Connection: close",
        ...Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n"),
    );
  });
}
