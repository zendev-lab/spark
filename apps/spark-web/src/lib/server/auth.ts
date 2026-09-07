import { createHash } from "node:crypto";
import type { SparkLocalRpcOutput } from "@zendev-lab/spark-protocol";
import {
  requestSparkDaemon,
  resolveSparkWebRequestTrustFailure,
  sparkWebTokenFromCarriers,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
  type SparkWebAuthSource,
  type SparkWebRequestTrust,
  type SparkWebTokenVerification,
} from "@zendev-lab/spark-daemon-client";

import {
  isSparkWebLoopbackHost,
  resolveSparkWebLanAddresses,
  SPARK_WEB_ALL_INTERFACES_HOST,
} from "./bind.ts";

export { SPARK_WEB_TOKEN_COOKIE, SPARK_WEB_TOKEN_HEADER, SPARK_WEB_TOKEN_QUERY };
export type { SparkWebAuthSource, SparkWebRequestTrust, SparkWebTokenVerification };
export const SPARK_WEB_BIND_HOST_ENV = "SPARK_WEB_BIND_HOST";
export const SPARK_WEB_BIND_PORT_ENV = "SPARK_WEB_BIND_PORT";

/**
 * Spark Web is an authentication adapter, not a token owner. The daemon owns
 * bootstrap and browser-session credentials (hashed storage, expiry, revocation).
 * This surface presents credentials to the daemon and persists its issued
 * access/refresh pair in cookies; it never maintains a credential database.
 */
export type SparkWebTokenVerifier = (token: string) => Promise<SparkWebTokenVerification>;

async function verifySparkWebTokenWithDaemon(token: string): Promise<SparkWebTokenVerification> {
  try {
    const result = token.startsWith("spark_web_access_")
      ? await requestSparkDaemon("daemon.access.session", { action: "verify", token })
      : await requestSparkDaemon("daemon.access.verify", { token });
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

export function sparkWebRequestTrustError(input: {
  request: Request;
  authSource: SparkWebAuthSource;
  trust: SparkWebRequestTrust;
  clientAddress: string | null | undefined;
}): string | null {
  return requestTrustError(input, true);
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
  const failure = resolveSparkWebRequestTrustFailure({
    method: input.request.method,
    host: input.request.headers.get("host"),
    origin: input.request.headers.get("origin"),
    fetchSite: input.request.headers.get("sec-fetch-site"),
    fetchMode: input.request.headers.get("sec-fetch-mode"),
    fetchDest: input.request.headers.get("sec-fetch-dest"),
    authSource: input.authSource,
    trust: input.trust,
    clientAddress: input.clientAddress,
    allowCrossSiteDocumentNavigation,
  });
  switch (failure) {
    case "host":
      return "Spark web rejected the request Host";
    case "cross-site":
      return "Spark web rejected a cross-site request";
    case "origin":
      return "Spark web rejected the request Origin";
    case "mutation-source":
      return "Spark web requires same-origin metadata for cookie-authenticated mutations";
    default:
      return null;
  }
}

export const SPARK_WEB_REFRESH_COOKIE = "spark_web_refresh";
export type SparkWebBrowserSession = NonNullable<
  SparkLocalRpcOutput<"daemon.access.session">["session"]
>;
type BrowserSessionClient = (
  action: "exchange" | "refresh",
  token: string,
) => Promise<SparkLocalRpcOutput<"daemon.access.session">>;
const defaultBrowserSessionClient: BrowserSessionClient = (action, token) =>
  requestSparkDaemon("daemon.access.session", { action, token });
let browserSessionClient = defaultBrowserSessionClient;
type BrowserSessionResolution = {
  verification: SparkWebTokenVerification;
  session?: SparkWebBrowserSession;
};
// Reloads can cancel a response after the daemon consumes its refresh token.
// Briefly share that response with retries, while rechecking daemon revocation.
const refreshResponses = new Map<
  string,
  { expiresAt: number; result: Promise<BrowserSessionResolution> }
>();
const refreshRetryWindowMs = 30_000;

export function setSparkWebBrowserSessionClient(client?: BrowserSessionClient): void {
  browserSessionClient = client ?? defaultBrowserSessionClient;
  refreshResponses.clear();
}

export async function resolveSparkWebBrowserSession(
  action: "exchange" | "refresh",
  token: string,
): Promise<BrowserSessionResolution> {
  if (action === "exchange") return requestBrowserSession(action, token);
  const now = Date.now();
  for (const [key, entry] of refreshResponses) {
    if (entry.expiresAt <= now) refreshResponses.delete(key);
  }
  const key = createHash("sha256").update(token).digest("hex");
  const cached = refreshResponses.get(key);
  if (cached) {
    const result = await cached.result;
    if (!result.session) return result;
    const verification = await verifySparkWebAccessToken(result.session.sessionToken);
    return verification === "valid" ? result : { verification };
  }
  const result = requestBrowserSession(action, token);
  if (refreshResponses.size >= 256) refreshResponses.delete(refreshResponses.keys().next().value!);
  const entry = { expiresAt: now + refreshRetryWindowMs, result };
  refreshResponses.set(key, entry);
  setTimeout(() => {
    if (refreshResponses.get(key) === entry) refreshResponses.delete(key);
  }, refreshRetryWindowMs).unref();
  const resolved = await result;
  if (!resolved.session && refreshResponses.get(key) === entry) refreshResponses.delete(key);
  return resolved;
}

async function requestBrowserSession(
  action: "exchange" | "refresh",
  token: string,
): Promise<BrowserSessionResolution> {
  try {
    const result = await browserSessionClient(action, token);
    return result.valid && result.session
      ? { verification: "valid", session: result.session }
      : { verification: "invalid" };
  } catch {
    return { verification: "unavailable" };
  }
}
