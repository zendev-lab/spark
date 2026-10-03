import { isIP, isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";

export const SPARK_WEB_TOKEN_COOKIE = "spark_web_token";
export const SPARK_WEB_TOKEN_QUERY = "token";
export const SPARK_WEB_TOKEN_HEADER = "x-spark-web-token";
export const SPARK_WEB_ACCESS_PATH = "/__spark/access";
export const SPARK_WEB_ACCESS_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
} as const;
export const SPARK_WEB_ACCESS_COOKIE = {
  path: "/",
  httpOnly: true,
  sameSite: "lax",
} as const;

export type SparkWebAccessPageState = "prompt" | "invalid" | "unavailable";
export type SparkWebTokenVerification = "valid" | "invalid" | "unavailable";
export type SparkWebAccessChallengeReason = "missing" | "invalid" | "unavailable";
export type SparkWebAuthSource = "query" | "header" | "cookie" | "none";
export type SparkWebRequestTrustFailure = "host" | "cross-site" | "origin" | "mutation-source";

export interface SparkWebRequestTrust {
  bindHost: string;
  bindPort: number;
  lanAddresses: readonly string[];
}

export type SparkWebAccessOutcome =
  | { type: "page"; status: number; state: SparkWebAccessPageState; returnTo: string }
  | { type: "redirect"; location: string; token?: string }
  | { type: "methodNotAllowed" };

export type SparkWebAccessChallenge =
  | { type: "page"; status: number; state: SparkWebAccessPageState }
  | { type: "carrier"; status: 401 | 503 };

/**
 * Direct browser access is a daemon-user carrier, not a token owner. Keep the
 * tiny framework-neutral surface here because both native Web and Web DSH are
 * already daemon clients and must present identical cookie/query/login
 * semantics without adding a UI-framework dependency between them.
 */
export function isSparkWebLoopbackClientAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = normalizeClientAddress(address);
  if (normalized === "localhost") return true;
  if (isIPv4(normalized)) return normalized.startsWith("127.");
  return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
}

/** Match upstream DSH's all-interface trust model: local non-loopback IPv4 literals only. */
export function resolveSparkWebLanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (iface): iface is NonNullable<typeof iface> =>
        iface !== undefined && iface.family === "IPv4" && !iface.internal,
    )
    .map((iface) => iface.address);
}

/** Format one directly reachable browser authority, including IPv6 brackets. */
export function sparkWebBrowserAuthority(host: string, port: number): string {
  const trimmed = host.trim();
  let parsed: URL;
  try {
    parsed = new URL(`http://${trimmed}`);
  } catch {
    parsed = new URL(`http://[${trimmed}]`);
  }
  const hostname =
    parsed.hostname.startsWith("[") || !parsed.hostname.includes(":")
      ? parsed.hostname
      : `[${parsed.hostname}]`;
  return parsed.port ? parsed.host : `${hostname}:${port}`;
}

/** Expand a wildcard listener into URLs a browser can actually open. */
export function sparkWebReachableHosts(
  host: string,
  lanAddresses: readonly string[] = resolveSparkWebLanAddresses(),
): string[] {
  if (isSparkWebLoopbackClientAddress(host)) return [host];
  if (host.trim() === "0.0.0.0") return ["127.0.0.1", ...lanAddresses];
  return [host];
}

export function sparkWebStartupAccessUrl(url: string, token: string): string {
  const accessUrl = new URL(url);
  accessUrl.searchParams.set(SPARK_WEB_TOKEN_QUERY, token);
  return accessUrl.toString();
}

export function isSparkWebHtmlNavigation(input: {
  method?: string | null;
  accept?: string | null;
}): boolean {
  const method = (input.method ?? "GET").toUpperCase();
  return (method === "GET" || method === "HEAD") && (input.accept ?? "").includes("text/html");
}

/**
 * Shared Host, Origin, Fetch Metadata, and mutation-source boundary for direct
 * Native Web and Web DSH access. Authentication and request provenance remain
 * independent boundaries for every TCP peer.
 */
export function resolveSparkWebRequestTrustFailure(input: {
  method?: string | null;
  host?: string | null;
  origin?: string | null;
  fetchSite?: string | null;
  fetchMode?: string | null;
  fetchDest?: string | null;
  authSource: SparkWebAuthSource;
  trust: SparkWebRequestTrust;
  clientAddress: string | null | undefined;
  allowCrossSiteDocumentNavigation?: boolean;
}): SparkWebRequestTrustFailure | null {
  const host = input.host?.trim().toLowerCase();
  if (!host || !isAllowedWebAuthority(host, input.trust, input.clientAddress)) return "host";

  const method = (input.method ?? "GET").toUpperCase();
  const fetchSite = input.fetchSite?.trim().toLowerCase();
  if (
    fetchSite === "cross-site" &&
    !(
      input.allowCrossSiteDocumentNavigation === true &&
      method === "GET" &&
      input.fetchMode?.trim().toLowerCase() === "navigate" &&
      input.fetchDest?.trim().toLowerCase() === "document"
    )
  ) {
    return "cross-site";
  }

  const origin = input.origin?.trim();
  if (origin && !originMatchesAuthority(origin, host)) return "origin";
  const mutation = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (mutation && input.authSource !== "header" && !origin && fetchSite !== "same-origin") {
    return "mutation-source";
  }
  return null;
}

export function sanitizeSparkWebReturnTo(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  try {
    const base = new URL("http://spark.local");
    const parsed = new URL(trimmed, base);
    if (parsed.origin !== base.origin) return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

export function sparkWebRequestReturnTo(url: URL): string {
  const next = new URL(url);
  next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
  return sanitizeSparkWebReturnTo(`${next.pathname}${next.search}`);
}

export function sparkWebTokenFromCarriers(input: {
  query?: string | null;
  header?: string | null;
  cookie?: string | null;
}): string | null {
  const query = input.query?.trim();
  if (query) return query;
  const header = input.header?.trim();
  if (header) return header;
  const cookie = input.cookie?.trim();
  return cookie || null;
}

export function sparkWebAccessSetCookie(token: string, secure = false): string {
  return [
    `${SPARK_WEB_TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export async function resolveSparkWebAccessRequest(input: {
  method?: string | null;
  returnTo?: string | null;
  token?: string | null;
  verify: (token: string) => Promise<SparkWebTokenVerification>;
}): Promise<SparkWebAccessOutcome> {
  const returnTo = sanitizeSparkWebReturnTo(input.returnTo);
  const method = (input.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return { type: "page", status: 200, state: "prompt", returnTo };
  }
  if (method !== "POST") return { type: "methodNotAllowed" };
  const token = input.token?.trim() ?? "";
  if (!token) return { type: "page", status: 401, state: "invalid", returnTo };
  const verification = await input.verify(token);
  if (verification === "unavailable") {
    return { type: "page", status: 503, state: "unavailable", returnTo };
  }
  if (verification !== "valid") return { type: "page", status: 401, state: "invalid", returnTo };
  return { type: "redirect", location: returnTo, token };
}

export function resolveSparkWebAccessChallenge(input: {
  htmlNavigation: boolean;
  reason: SparkWebAccessChallengeReason;
}): SparkWebAccessChallenge {
  if (!input.htmlNavigation) {
    return { type: "carrier", status: input.reason === "unavailable" ? 503 : 401 };
  }
  if (input.reason === "unavailable") return { type: "page", status: 503, state: "unavailable" };
  if (input.reason === "invalid") return { type: "page", status: 401, state: "invalid" };
  return { type: "page", status: 200, state: "prompt" };
}

export function renderSparkWebAccessPage(
  input: {
    state?: SparkWebAccessPageState;
    returnTo?: string;
    product?: string;
  } = {},
): string {
  const state = input.state ?? "prompt";
  const product = escapeHtml(input.product?.trim() || "Spark");
  const returnTo = escapeHtml(sanitizeSparkWebReturnTo(input.returnTo));
  const feedback =
    state === "invalid"
      ? '<p class="feedback error" role="alert">Invalid access token.</p>'
      : state === "unavailable"
        ? '<p class="feedback error" role="alert">Spark is temporarily unavailable. Try again after restarting Spark.</p>'
        : '<p class="feedback">Remote access requires a Spark access token.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${product} Access</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(92vw, 420px); padding: 32px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 16px; box-shadow: 0 16px 50px color-mix(in srgb, CanvasText 8%, transparent); }
    h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.02em; }
    .subtitle, .feedback, .hint { color: color-mix(in srgb, CanvasText 68%, transparent); }
    .subtitle { margin: 0 0 24px; }
    .feedback { min-height: 24px; margin: 0 0 16px; font-size: 14px; }
    .feedback.error { color: #d14343; }
    label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
    input { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 10px; background: Canvas; color: CanvasText; font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { width: 100%; min-height: 44px; margin-top: 14px; border: 0; border-radius: 10px; background: CanvasText; color: Canvas; font: inherit; font-weight: 650; cursor: pointer; }
    .hint { margin: 20px 0 0; font-size: 13px; line-height: 1.5; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>${product}</h1>
    <p class="subtitle">Continue to Spark</p>
    ${feedback}
    <form method="post" action="${SPARK_WEB_ACCESS_PATH}" autocomplete="off">
      <input type="hidden" name="returnTo" value="${returnTo}" />
      <label for="spark-access-token">Access token</label>
      <input id="spark-access-token" name="token" type="password" required autofocus spellcheck="false" autocomplete="off" placeholder="sdu_…" />
      <button type="submit">Continue</button>
    </form>
    <p class="hint">Use an access token created for Spark Web, including the token printed when Spark Web started.</p>
  </main>
</body>
</html>`;
}

function normalizeClientAddress(address: string): string {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .split("%", 1)[0]!;
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function isAllowedWebAuthority(
  authority: string,
  trust: SparkWebRequestTrust,
  clientAddress: string | null | undefined,
): boolean {
  const parsed = parseAuthority(authority);
  if (!parsed || parsed.port !== trust.bindPort) return false;
  if (isSparkWebLoopbackClientAddress(parsed.hostname)) {
    return isSparkWebLoopbackClientAddress(clientAddress);
  }
  if (isIP(parsed.hostname) === 0) return false;
  const bindHost = normalizeHostname(trust.bindHost);
  if (bindHost === "0.0.0.0") return trust.lanAddresses.includes(parsed.hostname);
  return parsed.hostname === bindHost;
}

function originMatchesAuthority(origin: string, authority: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.host.toLowerCase() === authority
    );
  } catch {
    return false;
  }
}

function parseAuthority(authority: string): { hostname: string; port: number } | null {
  try {
    const url = new URL(`http://${authority}`);
    if (
      !url.hostname ||
      url.host.toLowerCase() !== authority ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
