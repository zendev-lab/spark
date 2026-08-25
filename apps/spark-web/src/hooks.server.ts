import {
  isSparkWebHtmlNavigation,
  renderSparkWebAccessPage,
  sanitizeSparkWebReturnTo,
  SPARK_WEB_ACCESS_PATH,
} from "@zendev-lab/spark-daemon-client";
import type { Handle, RequestEvent } from "@sveltejs/kit";
import { error, redirect } from "@sveltejs/kit";

import { localeCookieName, resolveLocale } from "./lib/i18n.ts";

import {
  isSparkWebTokenRequired,
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
} from "./lib/server/auth.ts";

export const handle: Handle = async ({ event, resolve }) => {
  const trust = resolveSparkWebRequestTrust();
  const clientAddress = getClientAddress(event);
  const tokenRequired = isSparkWebTokenRequired(clientAddress);
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
        authSource: tokenRequired ? authSource : "none",
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
    return await handleAccessPage(event, tokenRequired);
  }

  if (tokenRequired) {
    // The daemon owns the daemon-user token family; a daemon that cannot be
    // reached fails closed instead of falling back to any local comparison.
    const provided = tokenFromRequest(credentials);
    if (!provided) {
      if (isHtmlNavigation(event.request)) {
        return accessPage("prompt", currentReturnTo(event));
      }
      error(401, "Spark web token required");
    }
    const verification = await verifySparkWebAccessToken(provided);
    if (verification === "unavailable") {
      if (isHtmlNavigation(event.request)) {
        return accessPage("unavailable", currentReturnTo(event), 503);
      }
      error(503, "Spark daemon is unavailable to verify the web token");
    }
    if (verification !== "valid") {
      if (isHtmlNavigation(event.request)) {
        return accessPage("invalid", currentReturnTo(event), 401);
      }
      error(401, "Spark web token required");
    }
    if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
      setAccessCookie(event, provided);
    }
  }
  if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
    const next = new URL(event.url);
    next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
    redirect(303, `${next.pathname}${next.search}`);
  }
  return resolveLocalized();
};

async function handleAccessPage(event: RequestEvent, tokenRequired: boolean): Promise<Response> {
  if (event.request.method === "GET" || event.request.method === "HEAD") {
    const returnTo = sanitizeSparkWebReturnTo(event.url.searchParams.get("returnTo"));
    if (!tokenRequired) redirect(303, returnTo);
    return accessPage("prompt", returnTo);
  }
  if (event.request.method !== "POST") error(405, "Method not allowed");

  const form = await event.request.formData();
  const returnTo = sanitizeSparkWebReturnTo(form.get("returnTo")?.toString());
  if (!tokenRequired) redirect(303, returnTo);
  const token = form.get("token")?.toString().trim() ?? "";
  if (!token) return accessPage("invalid", returnTo, 401);
  const verification = await verifySparkWebAccessToken(token);
  if (verification === "unavailable") return accessPage("unavailable", returnTo, 503);
  if (verification !== "valid") return accessPage("invalid", returnTo, 401);
  setAccessCookie(event, token);
  redirect(303, returnTo);
}

function isHtmlNavigation(request: Request): boolean {
  return isSparkWebHtmlNavigation({
    method: request.method,
    accept: request.headers.get("accept"),
  });
}

function currentReturnTo(event: RequestEvent): string {
  const next = new URL(event.url);
  next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
  return sanitizeSparkWebReturnTo(`${next.pathname}${next.search}`);
}

function accessPage(
  state: "prompt" | "invalid" | "unavailable",
  returnTo: string,
  status = 200,
): Response {
  return new Response(renderSparkWebAccessPage({ state, returnTo }), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function setAccessCookie(event: RequestEvent, token: string): void {
  event.cookies.set(SPARK_WEB_TOKEN_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: event.url.protocol === "https:",
  });
}

function getClientAddress(event: RequestEvent): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}
