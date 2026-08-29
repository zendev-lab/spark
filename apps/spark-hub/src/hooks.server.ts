import { createId } from "@zendev-lab/spark-protocol";
import {
  listUserDaemonGrantIds,
  listUserDaemonGrantWorkspaceIds,
} from "@zendev-lab/spark-hub-coordination/hub-access";
import type { Handle, HandleServerError, RequestEvent } from "@sveltejs/kit";
import {
  getCurrentHubSession,
  hubSessionAllowsRequest,
  refreshHubSession,
  sessionCookieName,
  sessionRefreshCookieName,
  setHubSessionCookies,
} from "$lib/server/auth";
import { getDatabase, pinDatabase, unpinDatabase } from "$lib/server/db";
import {
  hubServiceUnavailableResponse,
  isHubServiceUnavailableError,
  presentHubServerError,
} from "$lib/server/error-presentation";
import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "$lib/error-codes";
import { localeCookieName, resolveRequestLocale } from "$lib/i18n";
import { remoteAccessDecision } from "$lib/server/remote-access";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = createId("msg");
  event.locals.hasControlPlaneAccess = false;
  event.locals.authorizedWorkspaceIds = null;
  event.locals.authorizedDaemonIds = null;
  let databasePinned = false;
  try {
    pinDatabase();
    databasePinned = true;
    const db = getDatabase();

    event.locals.sessionToken = event.cookies.get(sessionCookieName) ?? null;
    let hubSession = getCurrentHubSession(db, event.locals.sessionToken);
    if (!hubSession) {
      const refreshed = refreshHubSession(db, event.cookies.get(sessionRefreshCookieName) ?? null);
      if (refreshed) {
        setHubSessionCookies(event.cookies, refreshed, {
          secure: event.url.protocol === "https:",
        });
        event.locals.sessionToken = refreshed.sessionToken;
        hubSession = getCurrentHubSession(db, refreshed.sessionToken);
      }
    }

    const clientAddress = getClientAddress(event);
    const decision = remoteAccessDecision({ url: event.url, clientAddress });
    event.locals.hasControlPlaneAccess = !decision.required || hubSession?.role === "owner";
    if (decision.required && !hubSession) {
      return remoteAccessRequiredResponse(event);
    }
    if (
      decision.required &&
      hubSession &&
      !hubSessionAllowsRequest(db, hubSession, event.url.pathname)
    ) {
      return hubAccessForbiddenResponse();
    }
    if (decision.required && hubSession && hubSession.role !== "owner") {
      event.locals.authorizedWorkspaceIds = listUserDaemonGrantWorkspaceIds(db, hubSession.userId);
      event.locals.authorizedDaemonIds = listUserDaemonGrantIds(db, hubSession.userId);
    }

    const locale = resolveRequestLocale({
      requestedLocale: event.url.searchParams.get("lang"),
      cookieLocale: event.cookies.get(localeCookieName),
      acceptLanguage: event.request.headers.get("accept-language"),
    });

    return await resolve(event, {
      transformPageChunk: ({ html }) => html.replace("%spark.locale%", locale),
    });
  } catch (error) {
    if (!isHubServiceUnavailableError(error)) throw error;
    console.warn(
      `[spark-hub] ${event.locals.requestId} 503 ${event.request.method} ${event.url.pathname} dependency unavailable`,
    );
    return hubServiceUnavailableResponse(event.locals.requestId);
  } finally {
    if (databasePinned) unpinDatabase();
  }
};

export const handleError: HandleServerError = ({ error, event, status, message }) => {
  const presented = presentHubServerError({
    error,
    status,
    fallbackMessage: message,
    requestId: event.locals.requestId,
  });
  if (presented.code === INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE) {
    console.warn(
      `[spark-hub] ${presented.requestId} invocation belongs to another Spark service (${event.url.pathname})`,
    );
  } else {
    console.error(
      `[spark-hub] ${presented.requestId} ${status} ${event.request.method} ${event.url.pathname}`,
      error,
    );
  }
  return presented;
};

function getClientAddress(event: RequestEvent): string | null {
  try {
    return event.getClientAddress();
  } catch {
    return null;
  }
}

function remoteAccessRequiredResponse(event: RequestEvent): Response {
  const acceptsHtml = event.request.headers.get("accept")?.includes("text/html") ?? false;
  if ((event.request.method === "GET" || event.request.method === "HEAD") && acceptsHtml) {
    const next = `${event.url.pathname}${event.url.search}`;
    return new Response(null, {
      status: 303,
      headers: { location: `/login?next=${encodeURIComponent(next)}` },
    });
  }

  return new Response(
    JSON.stringify({
      error: "hub_access_auth_required",
      message: "Spark Hub requires a Hub access session.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function hubAccessForbiddenResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "hub_access_forbidden",
      message: "This Hub session does not grant the requested resource.",
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
