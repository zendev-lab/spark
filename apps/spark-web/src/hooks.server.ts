import type { Handle } from "@sveltejs/kit";
import { error, redirect } from "@sveltejs/kit";

import {
  resolveSparkWebToken,
  SPARK_WEB_TOKEN_COOKIE,
  SPARK_WEB_TOKEN_HEADER,
  SPARK_WEB_TOKEN_QUERY,
  tokenFromRequest,
  tokensMatch,
} from "$lib/server/auth";

export const handle: Handle = async ({ event, resolve }) => {
  const expected = resolveSparkWebToken();
  const provided = tokenFromRequest({
    cookie: event.cookies.get(SPARK_WEB_TOKEN_COOKIE),
    query: event.url.searchParams.get(SPARK_WEB_TOKEN_QUERY),
    header: event.request.headers.get(SPARK_WEB_TOKEN_HEADER),
  });
  if (!tokensMatch(expected, provided)) {
    error(401, "Spark web token required");
  }
  event.locals.sparkWebToken = expected;
  if (event.url.searchParams.has(SPARK_WEB_TOKEN_QUERY)) {
    event.cookies.set(SPARK_WEB_TOKEN_COOKIE, expected, {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: false,
    });
    const next = new URL(event.url);
    next.searchParams.delete(SPARK_WEB_TOKEN_QUERY);
    redirect(303, `${next.pathname}${next.search}`);
  }
  return resolve(event);
};
