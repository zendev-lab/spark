import { randomBytes, timingSafeEqual } from "node:crypto";

import { isSparkWebLoopbackHost, normalizeSparkWebTrustedHost } from "./bind.ts";

export const SPARK_WEB_TOKEN_COOKIE = "spark_web_token";
export const SPARK_WEB_TOKEN_QUERY = "token";
export const SPARK_WEB_TOKEN_ENV = "SPARK_WEB_TOKEN";
export const SPARK_WEB_TOKEN_HEADER = "x-spark-web-token";
export const SPARK_WEB_BIND_HOST_ENV = "SPARK_WEB_BIND_HOST";
export const SPARK_WEB_BIND_PORT_ENV = "SPARK_WEB_BIND_PORT";
export const SPARK_WEB_TRUSTED_HOSTS_ENV = "SPARK_WEB_TRUSTED_HOSTS";

export function generateSparkWebToken(): string {
  return randomBytes(24).toString("base64url");
}

export function resolveSparkWebToken(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SPARK_WEB_TOKEN_ENV]?.trim();
  return configured && configured.length > 0 ? configured : generateSparkWebToken();
}

export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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

export function sparkWebRequestTrustError(input: {
  request: Request;
  authSource: SparkWebAuthSource;
  trust: SparkWebRequestTrust;
}): string | null {
  const hostHeader = input.request.headers.get("host")?.trim().toLowerCase();
  if (!hostHeader || !isAllowedAuthority(hostHeader, input.trust)) {
    return "Spark web rejected the request Host";
  }
  const fetchSite = input.request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") return "Spark web rejected a cross-site request";

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
