export function sanitizeHubReturnPath(value: string | null, origin: string): string {
  const candidate = value?.trim();
  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/u.test(candidate) ||
    /%5c/iu.test(candidate)
  ) {
    return "/";
  }
  try {
    const base = new URL(origin);
    const target = new URL(candidate, base);
    if (target.origin !== base.origin || target.username || target.password) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
