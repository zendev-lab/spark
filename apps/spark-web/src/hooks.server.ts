import type { Handle } from "@sveltejs/kit";
import { error, redirect } from "@sveltejs/kit";

import {
  resolveSparkWebToken,
  resolveSparkWebRequestTrust,
  isSparkWebReadOnlyShareRequest,
  sparkWebAuthSource,
  sparkWebRequestTrustError,
  sparkWebShareRequestTrustError,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
  tokenFromRequest,
  tokensMatch,
} from "$lib/server/auth";

export const handle: Handle = async ({ event, resolve }) => {
  const expected = resolveSparkWebToken();
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
  const trust = resolveSparkWebRequestTrust();
  const trustError = shareRequest
    ? sparkWebShareRequestTrustError({ request: event.request, trust })
    : sparkWebRequestTrustError({ request: event.request, authSource, trust });
  if (trustError) error(403, trustError);
  if (shareRequest) return resolve(event);
  const provided = tokenFromRequest(credentials);
  if (!tokensMatch(expected, provided)) {
    error(401, "Spark web token required");
  }
  event.locals.sparkWebToken = expected;
  if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
    event.cookies.set(SPARK_WEB_TOKEN_COOKIE, expected, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: event.url.protocol === "https:",
    });
    const next = new URL(event.url);
    next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
    redirect(303, `${next.pathname}${next.search}`);
  }
  return resolve(event);
};
