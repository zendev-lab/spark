import { requestSparkDaemon } from "@zendev-lab/spark-daemon-client";

import { isSparkWebLoopbackHost, normalizeSparkWebTrustedHost } from "./bind.ts";

export const SPARK_WEB_TOKEN_COOKIE = "spark_web_token";
export const SPARK_WEB_TOKEN_QUERY = "token";
export const SPARK_WEB_TOKEN_HEADER = "x-spark-web-token";
export const SPARK_WEB_BIND_HOST_ENV = "SPARK_WEB_BIND_HOST";
export const SPARK_WEB_BIND_PORT_ENV = "SPARK_WEB_BIND_PORT";
export const SPARK_WEB_TRUSTED_HOSTS_ENV = "SPARK_WEB_TRUSTED_HOSTS";

/**
 * Spark Web is an authentication adapter, not a token owner. The daemon owns
 * the `daemon-user` token family (hashed storage, expiry, revocation); this
 * surface only presents a token and asks the daemon to verify it. Loopback
 * listeners are tokenless; every non-loopback listener requires a valid
 * daemon-user token and fails closed when the daemon is unavailable.
 */
export type SparkWebTokenVerification = "valid" | "invalid" | "unavailable";

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
  const query = input.query?.trim();
  if (query) return query;
  const header = input.header?.trim();
  if (header) return header;
  const cookie = input.cookie?.trim();
  return cookie || null;
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
  trustedHosts: string[];
}

export function resolveSparkWebRequestTrust(
  env: NodeJS.ProcessEnv = process.env,
): SparkWebRequestTrust {
  const bindHost = env[SPARK_WEB_BIND_HOST_ENV]?.trim() || "127.0.0.1";
  const rawPort = Number(env[SPARK_WEB_BIND_PORT_ENV] ?? 4310);
  const bindPort =
    Number.isSafeInteger(rawPort) && rawPort > 0 && rawPort <= 65_535 ? rawPort : 4310;
  const trustedHosts = (env[SPARK_WEB_TRUSTED_HOSTS_ENV] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeSparkWebTrustedHost);
  return { bindHost, bindPort, trustedHosts };
}

/** Loopback listeners (IPv4 127/8, ::1, localhost) are tokenless. */
export function isSparkWebTokenRequired(trust: SparkWebRequestTrust): boolean {
  return !isSparkWebLoopbackHost(trust.bindHost);
}

export function sparkWebRequestTrustError(input: {
  request: Request;
  authSource: SparkWebAuthSource;
  trust: SparkWebRequestTrust;
}): string | null {
  return requestTrustError(input, false);
}

export function sparkWebShareRequestTrustError(input: {
  request: Request;
  trust: SparkWebRequestTrust;
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
  },
  allowCrossSiteDocumentNavigation: boolean,
): string | null {
  const hostHeader = input.request.headers.get("host")?.trim().toLowerCase();
  if (!hostHeader || !isAllowedAuthority(hostHeader, input.trust)) {
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

function isAllowedAuthority(authority: string, trust: SparkWebRequestTrust): boolean {
  const parsed = parseAuthority(authority);
  if (!parsed) return false;
  if (isSparkWebLoopbackHost(trust.bindHost)) {
    return isSparkWebLoopbackHost(parsed.hostname) && parsed.port === trust.bindPort;
  }
  return trust.trustedHosts.some((trusted) => {
    const expected = parseAuthority(trusted);
    return (
      expected !== null &&
      parsed.hostname === expected.hostname &&
      parsed.port === (expected.explicitPort ? expected.port : trust.bindPort)
    );
  });
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

function parseAuthority(
  authority: string,
): { hostname: string; port: number; explicitPort: boolean } | null {
  try {
    const url = new URL(`http://${authority}`);
    if (!url.hostname || url.username || url.password || url.pathname !== "/") return null;
    const explicitPort = url.port.length > 0;
    return {
      hostname: url.hostname.toLowerCase(),
      port: explicitPort ? Number(url.port) : 80,
      explicitPort,
    };
  } catch {
    return null;
  }
}
