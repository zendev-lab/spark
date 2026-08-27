/**
 * Spark Web DSH direct-access adapter for every bind.
 *
 * The daemon owns the `daemon-user` token family. The DSH compatibility server
 * stays on loopback; Spark's outer proxy owns the real network boundary,
 * validates local-IP Host/Origin metadata and asks the daemon to verify every
 * daemon-user token before forwarding a request to DSH.
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

import {
  isSparkWebHtmlNavigation,
  isSparkWebLoopbackClientAddress,
  renderSparkWebAccessPage,
  requestSparkDaemon,
  resolveSparkWebRequestTrustFailure,
  resolveSparkWebAccessChallenge,
  resolveSparkWebAccessRequest,
  resolveSparkWebLanAddresses,
  SPARK_WEB_ACCESS_PAGE_HEADERS,
  SPARK_WEB_ACCESS_PATH,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
  sparkWebAccessSetCookie,
  sparkWebRequestReturnTo,
  sparkWebTokenFromCarriers,
  type SparkWebTokenVerification,
  type SparkWebAuthSource,
} from "@zendev-lab/spark-daemon-client";

import { SPARK_WEB_DSH_PROXY_HEADER } from "./private-webserver.ts";

export const SPARK_WEB_DSH_TOKEN_QUERY = SPARK_WEB_TOKEN_QUERY;
export const SPARK_WEB_DSH_TOKEN_HEADER = SPARK_WEB_TOKEN_HEADER;
export const SPARK_WEB_DSH_TOKEN_COOKIE = SPARK_WEB_TOKEN_COOKIE;

export function isSparkWebDshLoopbackHost(host: string): boolean {
  return isSparkWebLoopbackClientAddress(host);
}

/** Local non-loopback IPv4 literals are the only remote browser authorities. */
export function resolveSparkWebDshLanAddresses(): string[] {
  return resolveSparkWebLanAddresses();
}

/**
 * Preserve trusted loopback/LAN browser authorities across Spark's private
 * loopback hop. DNS authorities are never rewritten; the outer trust fence
 * rejects them instead of maintaining another trusted-host channel.
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
  if (
    !hostUrl ||
    !(lanAddresses.includes(hostUrl.hostname) || isSparkWebDshLoopbackHost(hostUrl.hostname))
  ) {
    return headers;
  }

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

export type SparkWebDshTokenVerification = SparkWebTokenVerification;
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
  /** Per-process credential required by the private DSH WebServer adapter. */
  proxyCredential: string;
  verify?: SparkWebDshTokenVerifier;
  /** Test seam; production derives the values from the listener host. */
  lanAddresses?: readonly string[];
}

export interface SparkWebDshAuthProxy {
  server: Server;
  close(): Promise<void>;
}

/** Start Spark's trust and authentication proxy in front of the private DSH server. */
export async function startSparkWebDshAuthProxy(
  options: SparkWebDshAuthProxyOptions,
): Promise<SparkWebDshAuthProxy> {
  const targetHost = options.targetHost ?? "127.0.0.1";
  const verify = options.verify ?? verifySparkWebDshTokenWithDaemon;
  const lanAddresses = [...(options.lanAddresses ?? resolveSparkWebDshLanAddresses())];

  const authenticate = async (request: IncomingMessage): Promise<AuthenticatedRequest> => {
    const url = new URL(request.url ?? "/", "http://proxy.invalid");
    const token = sparkWebTokenFromCarriers({
      query: url.searchParams.get(SPARK_WEB_DSH_TOKEN_QUERY),
      header: firstHeaderValue(request.headers[SPARK_WEB_DSH_TOKEN_HEADER]),
      cookie: cookieValue(request.headers.cookie, SPARK_WEB_DSH_TOKEN_COOKIE),
    });
    const queryToken = url.searchParams.get(SPARK_WEB_DSH_TOKEN_QUERY)?.trim() || undefined;
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
      const trustError = requestTrustError(request, {
        bindHost: options.host,
        bindPort: request.socket.localPort ?? options.port,
        lanAddresses,
      });
      if (trustError) return writePlain(response, 403, trustError);

      const url = new URL(request.url ?? "/", "http://proxy.invalid");
      if (url.pathname === SPARK_WEB_ACCESS_PATH) {
        return await handleAccessRequest(request, response, verify, url);
      }

      const auth = await authenticate(request);
      if (auth.outcome === "forbidden") {
        return writePlain(
          response,
          403,
          "spark web-dsh query tokens are only accepted for navigation",
        );
      }
      if (auth.outcome === "daemonUnavailable" || auth.outcome === "unauthenticated") {
        const reason =
          auth.outcome === "daemonUnavailable"
            ? "unavailable"
            : auth.hadToken
              ? "invalid"
              : "missing";
        const challenge = resolveSparkWebAccessChallenge({
          htmlNavigation: isHtmlNavigation(request),
          reason,
        });
        if (challenge.type === "page") {
          return writeAccessPage(
            response,
            challenge.state,
            sparkWebRequestReturnTo(url),
            challenge.status,
          );
        }
        return writePlain(
          response,
          challenge.status,
          auth.outcome === "daemonUnavailable"
            ? "spark web-dsh cannot reach the Spark daemon to verify the token"
            : "spark web-dsh requires a daemon access token (spark daemon access create)",
        );
      }
      if (auth.outcome === "promoteQueryToken") {
        const next = new URL(auth.url);
        next.searchParams.delete(SPARK_WEB_DSH_TOKEN_QUERY);
        return writeRedirect(response, `${next.pathname}${next.search}` || "/", auth.token);
      }
      proxyHttpRequest(
        request,
        response,
        targetHost,
        options.targetPort,
        lanAddresses,
        options.proxyCredential,
      );
    })().catch(() => {
      if (!response.headersSent) writePlain(response, 502, "spark web-dsh proxy failure");
      else response.destroy();
    });
  });

  // Live session updates arrive over WebSocket upgrades; authenticate the
  // handshake with the same network and daemon-user boundary before piping.
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const trustError = requestTrustError(request, {
        bindHost: options.host,
        bindPort: request.socket.localPort ?? options.port,
        lanAddresses,
      });
      if (trustError) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const auth = await authenticate(request);
      if (auth.outcome !== "authenticated") {
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
      prepareUpstreamHeaders(upstreamHeaders, options.proxyCredential);
      const upstream = netConnect(options.targetPort, targetHost, () => {
        upstream.write(
          `${request.method} ${upstreamPath(request.url)} HTTP/${request.httpVersion}\r\n`,
        );
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
  verify: SparkWebDshTokenVerifier,
  url: URL,
): Promise<void> {
  const form =
    (request.method ?? "GET").toUpperCase() === "POST" ? await readAccessForm(request) : undefined;
  const outcome = await resolveSparkWebAccessRequest({
    method: request.method,
    returnTo: form?.get("returnTo") ?? url.searchParams.get("returnTo"),
    token: form?.get("token"),
    verify,
  });
  if (outcome.type === "methodNotAllowed") return writePlain(response, 405, "Method not allowed");
  if (outcome.type === "redirect") return writeRedirect(response, outcome.location, outcome.token);
  return writeAccessPage(response, outcome.state, outcome.returnTo, outcome.status);
}

function requestTrustError(
  request: IncomingMessage,
  trust: { bindHost: string; bindPort: number; lanAddresses: readonly string[] },
): string | null {
  const url = new URL(request.url ?? "/", "http://proxy.invalid");
  const authSource = requestAuthSource(request, url);
  const failure = resolveSparkWebRequestTrustFailure({
    method: request.method,
    host: firstHeaderValue(request.headers.host),
    origin: firstHeaderValue(request.headers.origin),
    fetchSite: firstHeaderValue(request.headers["sec-fetch-site"]),
    fetchMode: firstHeaderValue(request.headers["sec-fetch-mode"]),
    fetchDest: firstHeaderValue(request.headers["sec-fetch-dest"]),
    authSource,
    trust,
    clientAddress: request.socket.remoteAddress,
    allowCrossSiteDocumentNavigation: true,
  });
  switch (failure) {
    case "host":
      return "Spark web-dsh rejected the request Host";
    case "cross-site":
      return "Spark web-dsh rejected a cross-site request";
    case "origin":
      return "Spark web-dsh rejected the request Origin";
    case "mutation-source":
      return "Spark web-dsh requires same-origin metadata for cookie-authenticated mutations";
    default:
      return null;
  }
}

function requestAuthSource(request: IncomingMessage, url: URL): SparkWebAuthSource {
  if (url.searchParams.get(SPARK_WEB_DSH_TOKEN_QUERY)?.trim()) return "query";
  if (firstHeaderValue(request.headers[SPARK_WEB_DSH_TOKEN_HEADER])?.trim()) return "header";
  if (cookieValue(request.headers.cookie, SPARK_WEB_DSH_TOKEN_COOKIE)?.trim()) return "cookie";
  return "none";
}

function proxyHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  targetHost: string,
  targetPort: number,
  lanAddresses: readonly string[],
  proxyCredential: string,
): void {
  const headers = normalizeSparkWebDshLanHeaders(
    request.headers,
    targetHost,
    targetPort,
    lanAddresses,
  );
  prepareUpstreamHeaders(headers, proxyCredential);
  const upstream = httpRequest(
    {
      host: targetHost,
      port: targetPort,
      method: request.method,
      path: upstreamPath(request.url),
      headers,
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

function upstreamPath(rawUrl: string | undefined): string {
  const url = new URL(rawUrl ?? "/", "http://proxy.invalid");
  url.searchParams.delete(SPARK_WEB_DSH_TOKEN_QUERY);
  return `${url.pathname}${url.search}`;
}

function prepareUpstreamHeaders(headers: IncomingHttpHeaders, proxyCredential: string): void {
  headers[SPARK_WEB_DSH_PROXY_HEADER] = proxyCredential;
  delete headers[SPARK_WEB_DSH_TOKEN_HEADER];
  const cookie = firstHeaderValue(headers.cookie);
  if (cookie === undefined) return;
  const retained = cookie
    .split(";")
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator < 0 || part.slice(0, separator).trim() !== SPARK_WEB_DSH_TOKEN_COOKIE;
    })
    .join(";");
  if (retained.trim()) headers.cookie = retained;
  else delete headers.cookie;
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

function writeAccessPage(
  response: ServerResponse,
  state: "prompt" | "invalid" | "unavailable",
  returnTo: string,
  status: number,
): void {
  response.writeHead(status, SPARK_WEB_ACCESS_PAGE_HEADERS);
  response.end(renderSparkWebAccessPage({ state, returnTo }));
}

function writeRedirect(response: ServerResponse, location: string, token?: string): void {
  const headers: Record<string, string> = { location };
  if (token) headers["set-cookie"] = sparkWebAccessSetCookie(token);
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
