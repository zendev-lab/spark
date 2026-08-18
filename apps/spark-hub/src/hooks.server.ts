import type { DatabaseSync } from "node:sqlite";
import { createId } from "@zendev-lab/spark-protocol";
import type { Handle, HandleServerError, RequestEvent } from "@sveltejs/kit";
import {
  getCurrentHubSession,
  getCurrentWorkspaceSession,
  isRemoteWorkspaceDataPath,
  refreshHubSession,
  refreshWorkspaceSession,
  sessionCookieName,
  sessionRefreshCookieName,
  setHubSessionCookies,
  setWorkspaceSessionCookies,
  workspaceSessionAllowsRequest,
  workspaceSessionCookieName,
  workspaceSessionRefreshCookieName,
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
import { loadWorkspaceByRouteId } from "$lib/server/workspace-routing";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.requestId = createId("msg");
  event.locals.hasControlPlaneAccess = false;
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
        hubSession = refreshed;
      }
    }

    event.locals.workspaceSessionToken = event.cookies.get(workspaceSessionCookieName) ?? null;
    let workspaceSession = getCurrentWorkspaceSession(db, event.locals.workspaceSessionToken);
    if (!workspaceSession) {
      const refreshed = refreshWorkspaceSession(
        db,
        event.cookies.get(workspaceSessionRefreshCookieName) ?? null,
      );
      if (refreshed) {
        setWorkspaceSessionCookies(event.cookies, refreshed, {
          secure: event.url.protocol === "https:",
        });
        event.locals.workspaceSessionToken = refreshed.sessionToken;
        workspaceSession = refreshed;
      }
    }
    event.locals.workspaceId = workspaceSession?.workspaceId ?? null;

    const clientAddress = getClientAddress(event);
    const decision = remoteAccessDecision({ url: event.url, clientAddress });
    event.locals.hasControlPlaneAccess = !decision.required || Boolean(hubSession);
    if (decision.required && !hubSession && !workspaceSession) {
      const routeWorkspace = activeRouteWorkspace(db, event.url.pathname);
      return routeWorkspace
        ? remoteAccessRequiredResponse(event, "workspace", routeWorkspace.slug)
        : remoteAccessRequiredResponse(event, "hub");
    }
    if (
      decision.required &&
      hubSession &&
      !workspaceSession &&
      isRemoteWorkspaceDataPath(event.url.pathname)
    ) {
      const slug = workspaceSlugFromPath(event.url.pathname);
      if (slug) {
        return remoteAccessRequiredResponse(event, "workspace", slug);
      }
    }
    if (
      decision.required &&
      workspaceSession &&
      !workspaceSessionAllowsRequest(db, workspaceSession.workspaceId, event.url.pathname)
    ) {
      const routeWorkspace = activeRouteWorkspace(db, event.url.pathname);
      if (routeWorkspace && routeWorkspace.id !== workspaceSession.workspaceId) {
        return remoteAccessRequiredResponse(event, "workspace", routeWorkspace.slug);
      }
      // Hub owner sessions may still use control-plane routes.
      if (!hubSession || isRemoteWorkspaceDataPath(event.url.pathname)) {
        return workspaceAccessForbiddenResponse(workspaceSession.workspaceSlug);
      }
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

function workspaceSlugFromPath(pathname: string): string | null {
  const segment = pathname.split("/").filter(Boolean)[0];
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function activeRouteWorkspace(db: DatabaseSync, pathname: string) {
  const routeId = workspaceSlugFromPath(pathname);
  return routeId ? loadWorkspaceByRouteId(db, routeId) : undefined;
}

function remoteAccessRequiredResponse(
  event: RequestEvent,
  layer: "hub" | "workspace",
  workspaceSlug?: string,
): Response {
  const acceptsHtml = event.request.headers.get("accept")?.includes("text/html") ?? false;
  if ((event.request.method === "GET" || event.request.method === "HEAD") && acceptsHtml) {
    const next = `${event.url.pathname}${event.url.search}`;
    const location =
      layer === "workspace" && workspaceSlug
        ? `/${encodeURIComponent(workspaceSlug)}/login?next=${encodeURIComponent(next)}`
        : `/login?next=${encodeURIComponent(next)}`;
    return new Response(null, {
      status: 303,
      headers: { location },
    });
  }

  return new Response(
    JSON.stringify({
      error: layer === "workspace" ? "workspace_access_auth_required" : "hub_access_auth_required",
      message:
        layer === "workspace"
          ? "Spark Hub requires a workspace-scoped access session for this path."
          : "Spark Hub requires a Hub access session.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

function workspaceAccessForbiddenResponse(workspaceSlug: string): Response {
  return new Response(
    JSON.stringify({
      error: "workspace_access_forbidden",
      message: `This browser session grants only workspace ${workspaceSlug}.`,
    }),
    { status: 403, headers: { "content-type": "application/json" } },
  );
}
