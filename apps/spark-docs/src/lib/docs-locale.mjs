export const docsLocaleStorageKey = "spark-docs-locale";

/**
 * Resolve the locale used for an initial visit to the unversioned docs root.
 * The function is deliberately self-contained so it can also be embedded in
 * the static page head before Starlight renders.
 *
 * @param {{
 *   pathname: string;
 *   storedLocale?: string | null;
 *   languages?: readonly string[];
 *   language?: string;
 *   storageAvailable?: boolean;
 * }} input
 * @returns {string | null}
 */
export function rootLocaleRedirectTarget({
  pathname,
  storedLocale,
  languages = [],
  language = "",
  storageAvailable = true,
}) {
  if (pathname !== "/" || !storageAvailable) return null;
  if (storedLocale === "root") return null;
  if (storedLocale === "zh") return "/zh/";

  const candidates = [...languages, language];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const primaryLanguage = candidate.trim().toLowerCase().split(/[-_]/u, 1)[0];
    if (primaryLanguage === "zh") return "/zh/";
    if (primaryLanguage === "en") return null;
  }

  return null;
}

/**
 * Generate the inline script used on the docs root. A storage read failure is
 * treated as an unavailable manual-preference channel and safely keeps English.
 * Browser inference is intentionally not persisted.
 *
 * @param {string} [storageKey]
 */
export function createLocaleRedirectScript(storageKey = docsLocaleStorageKey) {
  return `
    (() => {
      if (window.location.pathname !== "/") return;

      let storedLocale;
      try {
        storedLocale = window.localStorage.getItem(${JSON.stringify(storageKey)});
      } catch {
        return;
      }

      let target;
      try {
        target = (${rootLocaleRedirectTarget.toString()})({
          pathname: window.location.pathname,
          storedLocale,
          languages: Array.isArray(navigator.languages) ? navigator.languages : [],
          language: navigator.language,
        });
      } catch {
        return;
      }

      if (target) window.location.replace(target);
    })();
  `.trim();
}

/**
 * Preserve the current page and version while changing the locale prefix.
 *
 * @param {string} pathname
 * @param {string | undefined} locale
 * @param {{
 *   baseUrl?: string;
 *   localeCodes?: readonly string[];
 *   trailingSlash?: "always" | "never" | "ignore";
 * }} [options]
 */
export function localizedDocsPathname(
  pathname,
  locale,
  { baseUrl = "/", localeCodes = ["root", "zh"], trailingSlash = "ignore" } = {},
) {
  let localizedPathname = pathname;
  const targetLocale = locale === "root" ? "" : locale;
  const base = baseUrl === "/" ? "" : stripTrailingSlash(baseUrl);
  const hasBase =
    base !== "" && (localizedPathname === base || localizedPathname.startsWith(`${base}/`));

  if (hasBase) localizedPathname = localizedPathname.slice(base.length) || "/";

  const [, baseSegment] = localizedPathname.split("/");
  const htmlExtension = ".html";
  const isRootHtml = baseSegment?.endsWith(htmlExtension);
  const baseSlug = isRootHtml ? baseSegment.slice(0, -htmlExtension.length) : baseSegment;

  if (baseSlug && localeCodes.includes(baseSlug)) {
    if (targetLocale) {
      localizedPathname = localizedPathname.replace(`/${baseSlug}`, `/${targetLocale}`);
    } else if (isRootHtml) {
      localizedPathname = "/index.html";
    } else {
      localizedPathname = localizedPathname.replace(`/${baseSlug}`, "") || "/";
    }
  } else if (targetLocale) {
    localizedPathname =
      baseSegment === "index.html"
        ? `/${targetLocale}.html`
        : `/${targetLocale}${localizedPathname}`;
  }

  if (hasBase) localizedPathname = `${base}${localizedPathname}`;
  if (trailingSlash === "never") localizedPathname = stripTrailingSlash(localizedPathname);
  return localizedPathname;
}

/**
 * Persist only explicit locale selections. Callers can safely continue when
 * storage is blocked or unavailable.
 *
 * @param {Pick<Storage, "setItem">} storage
 * @param {string | undefined} locale
 */
export function persistDocsLocalePreference(storage, locale) {
  if (locale !== "root" && locale !== "zh") return false;
  try {
    storage.setItem(docsLocaleStorageKey, locale);
    return true;
  } catch {
    return false;
  }
}

function stripTrailingSlash(pathname) {
  return pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
}
