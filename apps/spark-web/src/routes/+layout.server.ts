import { getDictionary, localeCookieName, resolveLocale } from "$lib/i18n";
import { loadSparkWebNavigation } from "$lib/server/navigation";
import type { ServerLoadEvent } from "@sveltejs/kit";

export const load = async ({ cookies, request, url, depends }: ServerLoadEvent) => {
  depends("spark:navigation");
  const requestedLocale = url.searchParams.get("lang");
  const locale = resolveLocale({
    requestedLocale,
    cookieLocale: cookies.get(localeCookieName),
    acceptLanguage: request.headers.get("accept-language"),
  });

  if (requestedLocale) {
    cookies.set(localeCookieName, locale, {
      path: "/",
      sameSite: "strict",
      secure: url.protocol === "https:",
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  return { locale, messages: getDictionary(locale), navigation: await loadSparkWebNavigation() };
};
