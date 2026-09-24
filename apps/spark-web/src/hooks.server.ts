import {
  isSparkWebHtmlNavigation,
  renderSparkWebAccessPage,
  resolveSparkWebAccessChallenge,
  resolveSparkWebAccessRequest,
  SPARK_WEB_ACCESS_COOKIE,
  SPARK_WEB_ACCESS_PAGE_HEADERS,
  SPARK_WEB_ACCESS_PATH,
  sparkWebRequestReturnTo,
} from "@zendev-lab/spark-daemon-client";
import type { Handle, RequestEvent } from "@sveltejs/kit";
import { error, redirect } from "@sveltejs/kit";

import { localeCookieName, resolveLocale } from "./lib/i18n.ts";

import {
  isSparkWebReadOnlyShareRequest,
  resolveSparkWebRequestTrust,
  sparkWebAuthSource,
  sparkWebRequestTrustError,
  sparkWebShareRequestTrustError,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
  tokenFromRequest,
  verifySparkWebAccessToken,
  resolveSparkWebBrowserSession,
  SPARK_WEB_REFRESH_COOKIE,
  type SparkWebBrowserSession,
} from "./lib/server/auth.ts";

export const handle: Handle = async ({ event, resolve }) => {
  const trust = resolveSparkWebRequestTrust();
  const clientAddress = getClientAddress(event);
  const credentials = {
    cookie: event.cookies.get(SPARK_WEB_TOKEN_COOKIE),
    query: event.url.searchParams.get(SPARK_WEB_TOKEN_QUERY),
    header: event.request.headers.get(SPARK_WEB_TOKEN_HEADER),
  };
  const authSource = sparkWebAuthSource(credentials);
  const shareRequest = isSparkWebReadOnlyShareRequest(event.request, event.url.pathname);
  if (authSource === "query" && event.request.method !== "GET") {
    error(403, "Spark web query tokens are only accepted for navigation");
  }
  const trustError = shareRequest
    ? sparkWebShareRequestTrustError({ request: event.request, trust, clientAddress })
    : sparkWebRequestTrustError({
        request: event.request,
        authSource,
        trust,
        clientAddress,
      });
  if (trustError) error(403, trustError);

  const locale = resolveLocale({
    requestedLocale: event.url.searchParams.get("lang"),
    cookieLocale: event.cookies.get(localeCookieName),
    acceptLanguage: event.request.headers.get("accept-language"),
  });
  const resolveLocalized = () =>
    resolve(event, {
      transformPageChunk: ({ html }) => html.replace("%spark.locale%", locale),
    });
  if (shareRequest) return resolveLocalized();

  if (event.url.pathname === SPARK_WEB_ACCESS_PATH) {
    return await handleAccessPage(event);
  }

  // The daemon owns the daemon-user token family; a daemon that cannot be
  // reached fails closed instead of falling back to any local comparison.
  const provided = tokenFromRequest(credentials);
  let verification: "missing" | "valid" | "invalid" | "unavailable" = provided
    ? await verifySparkWebAccessToken(provided)
    : "missing";
  let browserSession: SparkWebBrowserSession | undefined;
  const refreshToken = event.cookies.get(SPARK_WEB_REFRESH_COOKIE);
  if (
    verification !== "valid" &&
    verification !== "unavailable" &&
    refreshToken &&
    (authSource === "cookie" || authSource === "none")
  ) {
    const refreshed = await resolveSparkWebBrowserSession("refresh", refreshToken);
    verification = refreshed.verification;
    browserSession = refreshed.session;
  } else if (
    verification === "valid" &&
    provided &&
    (authSource === "query" || (authSource === "cookie" && provided.startsWith("sdu_")))
  ) {
    const exchanged = await resolveSparkWebBrowserSession("exchange", provided);
    verification = exchanged.verification;
    browserSession = exchanged.session;
  }
  if (verification !== "valid") {
    const challenge = resolveSparkWebAccessChallenge({
      htmlNavigation: isHtmlNavigation(event.request),
      reason: verification === "unavailable" ? "unavailable" : provided ? "invalid" : "missing",
    });
    if (challenge.type === "page") {
      return accessPage(challenge.state, sparkWebRequestReturnTo(event.url), challenge.status);
    }
    error(
      challenge.status,
      challenge.status === 503
        ? "Spark is unavailable to verify the web token"
        : "Spark web token required",
    );
  }
  if (browserSession) setSessionCookies(event, browserSession);
  if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
    const next = new URL(event.url);
    next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
    redirect(303, `${next.pathname}${next.search}`);
  }
  return resolveLocalized();
};

async function handleAccessPage(event: RequestEvent): Promise<Response> {
  const form = event.request.method === "POST" ? await event.request.formData() : undefined;
  const formReturnTo = form?.get("returnTo");
  const formToken = form?.get("token");
  const outcome = await resolveSparkWebAccessRequest({
    method: event.request.method,
    returnTo:
      typeof formReturnTo === "string" ? formReturnTo : event.url.searchParams.get("returnTo"),
    token: typeof formToken === "string" ? formToken : null,
    verify: verifySparkWebAccessToken,
  });
  if (outcome.type === "methodNotAllowed") error(405, "Method not allowed");
  if (outcome.type === "redirect") {
    if (outcome.token) {
      const exchanged = await resolveSparkWebBrowserSession("exchange", outcome.token);
      if (!exchanged.session)
        return accessPage(
          exchanged.verification === "unavailable" ? "unavailable" : "invalid",
          outcome.location,
          exchanged.verification === "unavailable" ? 503 : 401,
        );
      setSessionCookies(event, exchanged.session);
    }
    redirect(303, outcome.location);
  }
  return accessPage(outcome.state, outcome.returnTo, outcome.status);
}

function isHtmlNavigation(request: Request): boolean {
  return isSparkWebHtmlNavigation({
    method: request.method,
    accept: request.headers.get("accept"),
  });
}

function accessPage(
  state: "prompt" | "invalid" | "unavailable",
  returnTo: string,
  status = 200,
): Response {
  return new Response(renderSparkWebAccessPage({ state, returnTo }), {
    status,
    headers: SPARK_WEB_ACCESS_PAGE_HEADERS,
  });
}

function setSessionCookies(event: RequestEvent, session: SparkWebBrowserSession): void {
  event.cookies.set(SPARK_WEB_TOKEN_COOKIE, session.sessionToken, {
    ...SPARK_WEB_ACCESS_COOKIE,
    secure: event.url.protocol === "https:",
    expires: new Date(session.expiresAt),
  });
  event.cookies.set(SPARK_WEB_REFRESH_COOKIE, session.refreshToken, {
    ...SPARK_WEB_ACCESS_COOKIE,
    secure: event.url.protocol === "https:",
    expires: new Date(session.refreshExpiresAt),
  });
}

function getClientAddress(event: RequestEvent): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}
