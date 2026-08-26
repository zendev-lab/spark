import { fail } from "@sveltejs/kit";
import {
  createHubAccessToken,
  listHubAccessTokens,
  revokeHubAccessToken,
} from "@zendev-lab/spark-hub-coordination/hub-access";
import { listHubDaemons } from "@zendev-lab/spark-hub-coordination";
import { getRequestDictionary, localeCookieName } from "$lib/i18n";
import { ensureCurrentOwnerSession } from "$lib/server/auth";
import { getDatabase } from "$lib/server/db";
import { formText } from "$lib/server/form-data";
import type { Actions, PageServerLoad } from "./$types";

export const load: PageServerLoad = () => {
  const db = getDatabase();
  return {
    accessTokens: listHubAccessTokens(db),
    daemons: listHubDaemons(db),
  };
};

export const actions: Actions = {
  createAccessToken: async ({ cookies, locals, request, url }) => {
    const messages = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings;
    const db = getDatabase();
    const userId = ensureCurrentOwnerSession(db, cookies, locals.sessionToken);
    const formData = await request.formData();
    const label = formText(formData, "label").trim() || messages.access.defaultTokenLabel;
    const memberName = formText(formData, "user").trim() || null;
    const daemonIds = formData
      .getAll("daemonIds")
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    if (daemonIds.length === 0) {
      return fail(400, {
        intent: "hubAccess",
        message: messages.formMessages.daemonRequired,
      });
    }
    let token: ReturnType<typeof createHubAccessToken>;
    try {
      token = createHubAccessToken(db, {
        daemonIds,
        memberName,
        createdByUserId: userId,
        label,
      });
    } catch (caught) {
      return fail(400, {
        intent: "hubAccess",
        message: caught instanceof Error ? caught.message : messages.formMessages.daemonRequired,
      });
    }
    const loginUrl = new URL("/login", url.origin);
    return {
      intent: "hubAccess",
      message: messages.access.tokenCreatedHint,
      accessToken: token.token,
      accessExpiresAt: token.expiresAt,
      accessDaemonIds: token.daemonIds,
      accessMemberName: token.memberName,
      loginUrl: loginUrl.toString(),
    };
  },

  revokeAccessToken: async ({ cookies, locals, request }) => {
    const messages = getRequestDictionary({
      cookieLocale: cookies.get(localeCookieName),
      acceptLanguage: request.headers.get("accept-language"),
    }).settings;
    const db = getDatabase();
    ensureCurrentOwnerSession(db, cookies, locals.sessionToken);
    const tokenId = formText(await request.formData(), "tokenId").trim();
    if (!tokenId) {
      return fail(400, {
        intent: "hubAccess",
        message: messages.formMessages.tokenIdRequired,
      });
    }
    const revoked = revokeHubAccessToken(db, { tokenId });
    return {
      intent: "hubAccess",
      message: revoked ? messages.formMessages.tokenRevoked : messages.formMessages.tokenNotActive,
    };
  },
};
