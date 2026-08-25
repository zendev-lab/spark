import type { Handle } from "@sveltejs/kit";
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
  const tokenRequired = isSparkWebTokenRequired(trust);
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
    ? sparkWebShareRequestTrustError({ request: event.request, trust })
    : sparkWebRequestTrustError({
        request: event.request,
        authSource: tokenRequired ? authSource : "none",
        trust,
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
  if (tokenRequired) {
    // The daemon owns the daemon-user token family; a daemon that cannot be
    // reached fails closed instead of falling back to any local comparison.
    const provided = tokenFromRequest(credentials);
    if (!provided) error(401, "Spark web token required");
    const verification = await verifySparkWebAccessToken(provided);
    if (verification === "unavailable") {
      error(503, "Spark daemon is unavailable to verify the web token");
    }
    if (verification !== "valid") {
      error(401, "Spark web token required");
    }
    if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
      event.cookies.set(SPARK_WEB_TOKEN_COOKIE, provided, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        secure: event.url.protocol === "https:",
      });
    }
  }
  if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
    const next = new URL(event.url);
    next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
    redirect(303, `${next.pathname}${next.search}`);
  }
  return resolveLocalized();
};
