import { isIP } from "node:net";

import {
  isSparkWebLoopbackClientAddress,
  requestSparkDaemon,
  sparkWebTokenFromCarriers,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
  type SparkWebTokenVerification,
} from "@zendev-lab/spark-daemon-client";

import {
  isSparkWebLoopbackHost,
  resolveSparkWebLanAddresses,
  SPARK_WEB_ALL_INTERFACES_HOST,
} from "./bind.ts";

export { SPARK_WEB_TOKEN_COOKIE, SPARK_WEB_TOKEN_HEADER, SPARK_WEB_TOKEN_QUERY };
export type { SparkWebTokenVerification };
export const SPARK_WEB_BIND_HOST_ENV = "SPARK_WEB_BIND_HOST";
export const SPARK_WEB_BIND_PORT_ENV = "SPARK_WEB_BIND_PORT";

/**
 * Spark Web is an authentication adapter, not a token owner. The daemon owns
 * the `daemon-user` token family (hashed storage, expiry, revocation); this
 * surface only presents a token and asks the daemon to verify it. Requests
 * arriving from an actual loopback peer are tokenless even when the listener
 * binds all interfaces; every remote peer requires a valid daemon-user token.
 */
export type SparkWebTokenVerifier = (token: string) => Promise<SparkWebTokenVerification>;

async function verifySparkWebTokenWithDaemon(token: string): Promise<SparkWebTokenVerification> {
  try {
    const result = await requestSparkDaemon("daemon.access.verify", { token });
    return result.valid ? "valid" : "invalid";
  } catch {
    return "unavailable";
  }
}

let sparkWebTokenVerifier: SparkWebTokenVerifier = verifySparkWebTokenWithDaemon;

/** Test seam for the server hooks; production keeps the daemon verifier. */
export function setSparkWebTokenVerifier(verifier?: SparkWebTokenVerifier): void {
  sparkWebTokenVerifier = verifier ?? verifySparkWebTokenWithDaemon;
}

export function verifySparkWebAccessToken(token: string): Promise<SparkWebTokenVerification> {
  return sparkWebTokenVerifier(token);
}

export function tokenFromRequest(input: {
  cookie?: string | null;
  query?: string | null;
  header?: string | null;
}): string | null {
  return sparkWebTokenFromCarriers(input);
}

export type SparkWebAuthSource = "query" | "header" | "cookie" | "none";

export function sparkWebAuthSource(input: {
  cookie?: string | null;
  query?: string | null;
  header?: string | null;
}): SparkWebAuthSource {
  if (input.query?.trim()) return "query";
  if (input.header?.trim()) return "header";
  if (input.cookie?.trim()) return "cookie";
  return "none";
}

export interface SparkWebRequestTrust {
  bindHost: string;
  bindPort: number;
  lanAddresses: string[];
}

export function resolveSparkWebRequestTrust(
  env: NodeJS.ProcessEnv = process.env,
): SparkWebRequestTrust {
  const bindHost = env[SPARK_WEB_BIND_HOST_ENV]?.trim() || "127.0.0.1";
  const rawPort = Number(env[SPARK_WEB_BIND_PORT_ENV] ?? 4310);
  const bindPort =
    Number.isSafeInteger(rawPort) && rawPort > 0 && rawPort <= 65_535 ? rawPort : 4310;
  const lanAddresses =
    bindHost === SPARK_WEB_ALL_INTERFACES_HOST ? resolveSparkWebLanAddresses() : [];
  return { bindHost, bindPort, lanAddresses };
}

/** Token policy follows the actual TCP peer, not the listener bind address. */
export function isSparkWebTokenRequired(clientAddress: string | null | undefined): boolean {
  return !isSparkWebLoopbackClientAddress(clientAddress);
}

export function sparkWebRequestTrustError(input: {
  request: Request;
  authSource: SparkWebAuthSource;
  trust: SparkWebRequestTrust;
  clientAddress: string | null | undefined;
}): string | null {
  return requestTrustError(input, false);
}

export function sparkWebShareRequestTrustError(input: {
  request: Request;
  trust: SparkWebRequestTrust;
  clientAddress: string | null | undefined;
}): string | null {
  return requestTrustError({ ...input, authSource: "none" }, true);
}

export function isSparkWebReadOnlyShareRequest(request: Request, pathname: string): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    /^\/share\/[A-Za-z0-9_-]{32}$/u.test(pathname)
  );
}

function requestTrustError(
  input: {
    request: Request;
    authSource: SparkWebAuthSource;
    trust: SparkWebRequestTrust;
    clientAddress: string | null | undefined;
  },
  allowCrossSiteDocumentNavigation: boolean,
): string | null {
  const hostHeader = input.request.headers.get("host")?.trim().toLowerCase();
  if (!hostHeader || !isAllowedAuthority(hostHeader, input.trust, input.clientAddress)) {
    return "Spark web rejected the request Host";
  }
  const fetchSite = input.request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (
    fetchSite === "cross-site" &&
    !(
      allowCrossSiteDocumentNavigation &&
      input.request.headers.get("sec-fetch-mode")?.trim().toLowerCase() === "navigate" &&
      input.request.headers.get("sec-fetch-dest")?.trim().toLowerCase() === "document"
    )
  ) {
    return "Spark web rejected a cross-site request";
  }

  const origin = input.request.headers.get("origin")?.trim();
  if (origin && !originMatchesAuthority(origin, hostHeader)) {
    return "Spark web rejected the request Origin";
  }
  const method = input.request.method.toUpperCase();
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (mutation && input.authSource !== "header" && !origin && fetchSite !== "same-origin") {
    return "Spark web requires same-origin metadata for cookie-authenticated mutations";
  }
  return null;
}

function isAllowedAuthority(
  authority: string,
  trust: SparkWebRequestTrust,
  clientAddress: string | null | undefined,
): boolean {
  const parsed = parseAuthority(authority);
  if (!parsed || parsed.port !== trust.bindPort) return false;
  if (isSparkWebLoopbackHost(parsed.hostname)) {
    return isSparkWebLoopbackClientAddress(clientAddress);
  }
  if (isIP(parsed.hostname) === 0) return false;
  const bindHost = normalizeHostname(trust.bindHost);
  if (bindHost === SPARK_WEB_ALL_INTERFACES_HOST) {
    return trust.lanAddresses.includes(parsed.hostname);
  }
  return parsed.hostname === bindHost;
}

function originMatchesAuthority(origin: string, authority: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.host.toLowerCase() === authority
    );
  } catch {
    return false;
  }
}

function parseAuthority(authority: string): { hostname: string; port: number } | null {
  try {
    const url = new URL(`http://${authority}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") return null;
    return {
      hostname: normalizeHostname(url.hostname),
      port: url.port.length > 0 ? Number(url.port) : 80,
    };
  } catch {
    return null;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
}
