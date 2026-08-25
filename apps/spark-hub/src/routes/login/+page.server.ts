import { fail, redirect } from "@sveltejs/kit";
import {
  HubAccessTokenError,
  hasActiveHubAccessTokens,
} from "@zendev-lab/spark-hub-coordination/hub-access";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import {
  exchangeHubAccessToken,
  getCurrentHubSession,
  setHubSessionCookies,
} from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ locals, url }) => {
  const next = safeNextPath(url.searchParams.get("next"));
  const current = getCurrentHubSession(getDatabase(), locals.sessionToken);
  if (current) {
    redirect(303, next === "/" ? "/" : next);
  }
  return {
    next,
    hubAccessAvailable: hasActiveHubAccessTokens(getDatabase()),
  };
};

export const actions: Actions = {
  default: async ({ cookies, request, url }) => {
    const t = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).login;
    const next = safeNextPath(url.searchParams.get("next"));
    const token = formText(await request.formData(), "token").trim();
    let session;
    try {
      session = exchangeHubAccessToken(getDatabase(), token);
    } catch (caught) {
      if (!(caught instanceof HubAccessTokenError)) throw caught;
      return fail(401, {
        next,
        hubAccessAvailable: hasActiveHubAccessTokens(getDatabase()),
        message: t.invalid,
      });
    }

    setHubSessionCookies(cookies, session, { secure: url.protocol === "https:" });
    redirect(303, next);
  },
};

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
