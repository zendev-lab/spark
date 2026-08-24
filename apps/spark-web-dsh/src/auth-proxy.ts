/**
 * Spark Web DSH authentication adapter for non-loopback binds.
 *
 * The daemon owns the `daemon-user` token family; this module is the narrowest
 * possible seam: it presents a bearer token and asks the daemon to verify it
 * through the local RPC `daemon.access.verify` procedure. The DSH
 * compatibility server itself always binds loopback; a non-loopback `spark
 * web-dsh --host` exposes only this proxy on the requested address.
 *
 * Loopback listeners stay tokenless (no proxy is created). On a non-loopback
 * listener every request needs a valid daemon-user token carried as the
 * `token` query parameter (navigation only), the `x-spark-web-token` header,
 * or the `spark_web_token` cookie — the same carrier convention as native
 * Spark Web. A verified query token is promoted to an HttpOnly cookie and
 * stripped from the URL. Every verification failure is one undifferentiated
 * 401, and an unreachable daemon fails closed with 503.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";

import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";

export const SPARK_WEB_DSH_TOKEN_QUERY = "token";
export const SPARK_WEB_DSH_TOKEN_HEADER = "x-spark-web-token";
export const SPARK_WEB_DSH_TOKEN_COOKIE = "spark_web_token";

/**
 * Loopback predicate shared with native Spark Web (`spark-web` bind.ts):
 * localhost, ::1, and the whole IPv4 127/8 block are tokenless listeners.
 */
export function isSparkWebDshLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

export type SparkWebDshTokenVerification = "valid" | "invalid" | "unavailable";

export type SparkWebDshTokenVerifier = (token: string) => Promise<SparkWebDshTokenVerification>;

/** Default verifier: the daemon-local RPC boundary, never a local store. */
export async function verifySparkWebDshTokenWithDaemon(
  token: string,
): Promise<SparkWebDshTokenVerification> {
  try {
    const result = await requestSparkDaemon("daemon.access.verify", { token });
    return result.valid ? "valid" : "invalid";
  } catch {
    return "unavailable";
  }
}

export interface SparkWebDshAuthProxyOptions {
  /** Outer non-loopback listen address shown to browsers. */
  host: string;
  port: number;
  /** Inner loopback address of the DSH compatibility server. */
  targetHost?: string;
  targetPort: number;
  verify?: SparkWebDshTokenVerifier;
}

export interface SparkWebDshAuthProxy {
  server: Server;
  close(): Promise<void>;
}

/** Start the authenticated proxy in front of a loopback-only DSH server. */
export async function startSparkWebDshAuthProxy(
  options: SparkWebDshAuthProxyOptions,
): Promise<SparkWebDshAuthProxy> {
  const targetHost = options.targetHost ?? "127.0.0.1";
  const verify = options.verify ?? verifySparkWebDshTokenWithDaemon;

  const authenticate = async (request: IncomingMessage): Promise<AuthenticatedRequest> => {
    const url = new URL(request.url ?? "/", "http://proxy.invalid");
    const queryToken = url.searchParams.get(SPARK_WEB_DSH_TOKEN_QUERY)?.trim() || undefined;
    const headerToken =
      firstHeaderValue(request.headers[SPARK_WEB_DSH_TOKEN_HEADER])?.trim() || undefined;
    const cookieToken = cookieValue(request.headers.cookie, SPARK_WEB_DSH_TOKEN_COOKIE);
    const token = queryToken ?? headerToken ?? cookieToken;
    if (queryToken && (request.method ?? "GET").toUpperCase() !== "GET") {
      return { outcome: "forbidden" };
    }
    if (!token) return { outcome: "unauthenticated" };
    const verification = await verify(token);
    if (verification === "unavailable") return { outcome: "daemonUnavailable" };
    if (verification !== "valid") return { outcome: "unauthenticated" };
    return queryToken ? { outcome: "promoteQueryToken", token, url } : { outcome: "authenticated" };
  };

  const server = createServer((request, response) => {
    void (async () => {
      const auth = await authenticate(request);
      if (auth.outcome === "forbidden") {
        return writePlain(
          response,
          403,
          "spark web-dsh query tokens are only accepted for navigation",
        );
      }
      if (auth.outcome === "daemonUnavailable") {
        return writePlain(
          response,
          503,
          "spark web-dsh cannot reach the Spark daemon to verify the token",
        );
      }
      if (auth.outcome === "unauthenticated") {
        return writePlain(
          response,
          401,
          "spark web-dsh requires a daemon access token (spark daemon access create)",
        );
      }
      if (auth.outcome === "promoteQueryToken") {
        const next = new URL(auth.url);
        next.searchParams.delete(SPARK_WEB_DSH_TOKEN_QUERY);
        response.writeHead(303, {
          location: `${next.pathname}${next.search}` || "/",
          "set-cookie": `${SPARK_WEB_DSH_TOKEN_COOKIE}=${encodeURIComponent(auth.token)}; Path=/; HttpOnly; SameSite=Strict`,
        });
        response.end();
        return;
      }
      proxyHttpRequest(request, response, targetHost, options.targetPort);
    })().catch(() => {
      if (!response.headersSent) writePlain(response, 502, "spark web-dsh proxy failure");
      else response.destroy();
    });
  });

  // Live session updates arrive over WebSocket upgrades; authenticate the
  // handshake with the same carriers before piping the raw socket.
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const auth = await authenticate(request);
      if (auth.outcome !== "authenticated" && auth.outcome !== "promoteQueryToken") {
        socket.write(
          `HTTP/1.1 ${auth.outcome === "daemonUnavailable" ? 503 : 401} Unauthorized\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      const upstream = netConnect(options.targetPort, targetHost, () => {
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
        for (const [name, value] of Object.entries(request.headers)) {
          if (value === undefined) continue;
          upstream.write(`${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`);
        }
        upstream.write("\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
    })().catch(() => socket.destroy());
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });

  return {
    server,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

type AuthenticatedRequest =
  | { outcome: "authenticated" }
  | { outcome: "promoteQueryToken"; token: string; url: URL }
  | { outcome: "unauthenticated" }
  | { outcome: "daemonUnavailable" }
  | { outcome: "forbidden" };

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targetHost: string,
  targetPort: number,
): void {
  const upstream = httpRequest(
    {
      host: targetHost,
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: request.headers,
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) writePlain(response, 502, "spark web-dsh lost the DSH server");
    else response.destroy();
  });
  request.pipe(upstream);
}

function writePlain(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value) || undefined;
    } catch {
      return value || undefined;
    }
  }
  return undefined;
}
