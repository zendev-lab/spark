/**
 * Spark Web DSH direct-access adapter for non-loopback binds.
 *
 * The daemon owns the `daemon-user` token family. The DSH compatibility server
 * stays on loopback; Spark's outer proxy owns the real network boundary,
 * validates local-IP Host/Origin metadata, classifies the actual TCP peer, and
 * asks the daemon to verify remote-user tokens. Loopback peers remain
 * tokenless even when the proxy listener binds 0.0.0.0.
 */
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";

import {
  isSparkWebHtmlNavigation,
  isSparkWebLoopbackClientAddress,
  renderSparkWebAccessPage,
  requestSparkDaemon,
  sanitizeSparkWebReturnTo,
  SPARK_WEB_ACCESS_PATH,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
} from "@zendev-lab/spark-daemon-client";

export const SPARK_WEB_DSH_TOKEN_QUERY = SPARK_WEB_TOKEN_QUERY;
export const SPARK_WEB_DSH_TOKEN_HEADER = SPARK_WEB_TOKEN_HEADER;
export const SPARK_WEB_DSH_TOKEN_COOKIE = SPARK_WEB_TOKEN_COOKIE;

export function isSparkWebDshLoopbackHost(host: string): boolean {
  return isSparkWebLoopbackClientAddress(host);
}

/** Local non-loopback IPv4 literals are the only remote browser authorities. */
export function resolveSparkWebDshLanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (iface): iface is NonNullable<typeof iface> =>
        iface !== undefined && iface.family === "IPv4" && !iface.internal,
    )
    .map((iface) => iface.address);
}

/**
 * Preserve DSH's LAN-IP trust semantics across Spark's loopback proxy. DNS
 * authorities are intentionally never rewritten; the outer trust fence rejects
 * them instead of maintaining a second trusted-host configuration channel.
 */
export function normalizeSparkWebDshLanHeaders(
  headers: IncomingHttpHeaders,
  targetHost: string,
  targetPort: number,
  lanAddresses: readonly string[],
): IncomingHttpHeaders {
  const host = firstHeaderValue(headers.host)?.trim();
  if (!host) return headers;
  const hostUrl = parseAuthority(host);
  if (!hostUrl || !lanAddresses.includes(hostUrl.hostname)) return headers;

  const target = authorityFor(targetHost, targetPort);
  const forwarded: IncomingHttpHeaders = { ...headers, host: target };
  const origin = firstHeaderValue(headers.origin)?.trim();
  if (!origin) return forwarded;

  try {
    const originUrl = new URL(origin);
    if (originUrl.host.toLowerCase() === hostUrl.host.toLowerCase()) {
      originUrl.host = target;
      forwarded.origin = originUrl.origin;
    }
  } catch {
    // Leave malformed origins untouched; DSH's trust fence will reject them.
  }
  return forwarded;
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
  /** Outer listen address shown to browsers. */
  host: string;
  port: number;
  /** Inner loopback address of the DSH compatibility server. */
  targetHost?: string;
  targetPort: number;
  verify?: SparkWebDshTokenVerifier;
  /** Test seams; production derives both values from the accepted socket/host. */
  requiresToken?: (request: IncomingMessage) => boolean;
  lanAddresses?: readonly string[];
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
  const lanAddresses = [...(options.lanAddresses ?? resolveSparkWebDshLanAddresses())];
  const requiresToken =
    options.requiresToken ??
    ((request: IncomingMessage) => !isSparkWebLoopbackClientAddress(request.socket.remoteAddress));

  const authenticate = async (request: IncomingMessage): Promise<AuthenticatedRequest> => {
    if (!requiresToken(request)) return { outcome: "authenticated" };
    const url = new URL(request.url ?? "/", "http://proxy.invalid");
    const queryToken = url.searchParams.get(SPARK_WEB_DSH_TOKEN_QUERY)?.trim() || undefined;
    const headerToken =
      firstHeaderValue(request.headers[SPARK_WEB_DSH_TOKEN_HEADER])?.trim() || undefined;
    const cookieToken = cookieValue(request.headers.cookie, SPARK_WEB_DSH_TOKEN_COOKIE);
    const token = queryToken ?? headerToken ?? cookieToken;
    if (queryToken && (request.method ?? "GET").toUpperCase() !== "GET") {
      return { outcome: "forbidden" };
    }
    if (!token) return { outcome: "unauthenticated", hadToken: false };
    const verification = await verify(token);
    if (verification === "unavailable") return { outcome: "daemonUnavailable" };
    if (verification !== "valid") return { outcome: "unauthenticated", hadToken: true };
    return queryToken ? { outcome: "promoteQueryToken", token, url } : { outcome: "authenticated" };
  };

  const server = createServer((request, response) => {
    void (async () => {
      const tokenRequired = requiresToken(request);
      const trustError = requestTrustError(request, tokenRequired, lanAddresses);
      if (trustError) return writePlain(response, 403, trustError);

      const url = new URL(request.url ?? "/", "http://proxy.invalid");
      if (url.pathname === SPARK_WEB_ACCESS_PATH) {
        return await handleAccessRequest(request, response, tokenRequired, verify, url);
      }

      const auth = await authenticate(request);
      if (auth.outcome === "forbidden") {
        return writePlain(
          response,
          403,
          "spark web-dsh query tokens are only accepted for navigation",
        );
      }
      if (auth.outcome === "daemonUnavailable") {
        if (isHtmlNavigation(request)) {
          return writeAccessPage(response, "unavailable", requestReturnTo(url), 503);
        }
        return writePlain(
          response,
          503,
          "spark web-dsh cannot reach the Spark daemon to verify the token",
        );
      }
      if (auth.outcome === "unauthenticated") {
        if (isHtmlNavigation(request)) {
          return writeAccessPage(
            response,
            auth.hadToken ? "invalid" : "prompt",
            requestReturnTo(url),
            auth.hadToken ? 401 : 200,
          );
        }
        return writePlain(
          response,
          401,
          "spark web-dsh requires a daemon access token (spark daemon access create)",
        );
      }
      if (auth.outcome === "promoteQueryToken") {
        const next = new URL(auth.url);
        next.searchParams.delete(SPARK_WEB_DSH_TOKEN_QUERY);
        return writeRedirect(response, `${next.pathname}${next.search}` || "/", auth.token);
      }
      proxyHttpRequest(request, response, targetHost, options.targetPort, lanAddresses);
    })().catch(() => {
      if (!response.headersSent) writePlain(response, 502, "spark web-dsh proxy failure");
      else response.destroy();
    });
  });

  // Live session updates arrive over WebSocket upgrades; authenticate the
  // handshake with the same network and daemon-user boundary before piping.
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const tokenRequired = requiresToken(request);
      const trustError = requestTrustError(request, tokenRequired, lanAddresses);
      if (trustError) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const auth = await authenticate(request);
      if (auth.outcome !== "authenticated" && auth.outcome !== "promoteQueryToken") {
        socket.write(
          `HTTP/1.1 ${auth.outcome === "daemonUnavailable" ? 503 : 401} Unauthorized\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
        return;
      }
      const upstreamHeaders = normalizeSparkWebDshLanHeaders(
        request.headers,
        targetHost,
        options.targetPort,
        lanAddresses,
      );
      const upstream = netConnect(options.targetPort, targetHost, () => {
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
        for (const [name, value] of Object.entries(upstreamHeaders)) {
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
  | { outcome: "unauthenticated"; hadToken: boolean }
  | { outcome: "daemonUnavailable" }
  | { outcome: "forbidden" };

async function handleAccessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  tokenRequired: boolean,
  verify: SparkWebDshTokenVerifier,
  url: URL,
): Promise<void> {
  if ((request.method ?? "GET").toUpperCase() === "GET") {
    const returnTo = sanitizeSparkWebReturnTo(url.searchParams.get("returnTo"));
    if (!tokenRequired) return writeRedirect(response, returnTo);
    return writeAccessPage(response, "prompt", returnTo, 200);
  }
  if ((request.method ?? "GET").toUpperCase() !== "POST") {
    return writePlain(response, 405, "Method not allowed");
  }
  const form = await readAccessForm(request);
  const returnTo = sanitizeSparkWebReturnTo(form.get("returnTo"));
  if (!tokenRequired) return writeRedirect(response, returnTo);
  const token = form.get("token")?.trim() ?? "";
  if (!token) return writeAccessPage(response, "invalid", returnTo, 401);
  const verification = await verify(token);
  if (verification === "unavailable") {
    return writeAccessPage(response, "unavailable", returnTo, 503);
  }
  if (verification !== "valid") return writeAccessPage(response, "invalid", returnTo, 401);
  return writeRedirect(response, returnTo, token);
}

function requestTrustError(
  request: IncomingMessage,
  tokenRequired: boolean,
  lanAddresses: readonly string[],
): string | null {
  const host = firstHeaderValue(request.headers.host)?.trim();
  const authority = host ? parseAuthority(host) : undefined;
  if (
    !authority ||
    !(
      lanAddresses.includes(authority.hostname) ||
      (!tokenRequired && isSparkWebDshLoopbackHost(authority.hostname))
    )
  ) {
    return "Spark web-dsh rejected the request Host";
  }
  const fetchSite = firstHeaderValue(request.headers["sec-fetch-site"])?.trim().toLowerCase();
  if (fetchSite === "cross-site") return "Spark web-dsh rejected a cross-site request";
  const origin = firstHeaderValue(request.headers.origin)?.trim();
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host!.toLowerCase()) {
        return "Spark web-dsh rejected the request Origin";
      }
    } catch {
      return "Spark web-dsh rejected the request Origin";
    }
  }
  return null;
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targetHost: string,
  targetPort: number,
  lanAddresses: readonly string[],
): void {
  const upstream = httpRequest(
    {
      host: targetHost,
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: normalizeSparkWebDshLanHeaders(
        request.headers,
        targetHost,
        targetPort,
        lanAddresses,
      ),
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

async function readAccessForm(request: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (body.length > 16 * 1024) throw new Error("access form exceeds 16 KiB");
  }
  return new URLSearchParams(body);
}

function isHtmlNavigation(request: IncomingMessage): boolean {
  return isSparkWebHtmlNavigation({
    method: request.method,
    accept: firstHeaderValue(request.headers.accept),
  });
}

function requestReturnTo(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete(SPARK_WEB_DSH_TOKEN_QUERY);
  return sanitizeSparkWebReturnTo(`${next.pathname}${next.search}`);
}

function writeAccessPage(
  response: ServerResponse,
  state: "prompt" | "invalid" | "unavailable",
  returnTo: string,
  status: number,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(renderSparkWebAccessPage({ state, returnTo }));
}

function writeRedirect(response: ServerResponse, location: string, token?: string): void {
  const headers: Record<string, string> = { location };
  if (token) {
    headers["set-cookie"] = `${SPARK_WEB_DSH_TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
  }
  response.writeHead(303, headers);
  response.end();
}

function authorityFor(host: string, port: number): string {
  const normalized = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${normalized}:${port}`;
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return undefined;
  }
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
