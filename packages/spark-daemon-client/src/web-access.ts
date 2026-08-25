export const SPARK_WEB_TOKEN_COOKIE = "spark_web_token";
export const SPARK_WEB_TOKEN_QUERY = "token";
export const SPARK_WEB_TOKEN_HEADER = "x-spark-web-token";
export const SPARK_WEB_ACCESS_PATH = "/__spark/access";

export type SparkWebAccessPageState = "prompt" | "invalid" | "unavailable";

/**
 * Direct browser access is a daemon-user carrier, not a token owner. Keep the
 * tiny framework-neutral surface here because both native Web and Web DSH are
 * already daemon clients and must present identical cookie/query/login
 * semantics without adding a UI-framework dependency between them.
 */
export function isSparkWebLoopbackClientAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = normalizeClientAddress(address);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

export function isSparkWebHtmlNavigation(input: {
  method?: string | null;
  accept?: string | null;
}): boolean {
  const method = (input.method ?? "GET").toUpperCase();
  return (method === "GET" || method === "HEAD") && (input.accept ?? "").includes("text/html");
}

export function sanitizeSparkWebReturnTo(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  try {
    const base = new URL("http://spark.local");
    const parsed = new URL(trimmed, base);
    if (parsed.origin !== base.origin) return "/";
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}

export function renderSparkWebAccessPage(input: {
  state?: SparkWebAccessPageState;
  returnTo?: string;
  product?: string;
} = {}): string {
  const state = input.state ?? "prompt";
  const product = escapeHtml(input.product?.trim() || "Spark");
  const returnTo = escapeHtml(sanitizeSparkWebReturnTo(input.returnTo));
  const feedback =
    state === "invalid"
      ? '<p class="feedback error" role="alert">Invalid access token.</p>'
      : state === "unavailable"
        ? '<p class="feedback error" role="alert">The Spark daemon is unavailable to verify this token.</p>'
        : '<p class="feedback">Remote access requires a daemon access token.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>${product} Access</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(92vw, 420px); padding: 32px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 16px; box-shadow: 0 16px 50px color-mix(in srgb, CanvasText 8%, transparent); }
    h1 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.02em; }
    .subtitle, .feedback, .hint { color: color-mix(in srgb, CanvasText 68%, transparent); }
    .subtitle { margin: 0 0 24px; }
    .feedback { min-height: 24px; margin: 0 0 16px; font-size: 14px; }
    .feedback.error { color: #d14343; }
    label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 600; }
    input { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius: 10px; background: Canvas; color: CanvasText; font: 14px ui-monospace, SFMono-Regular, Menlo, monospace; }
    button { width: 100%; min-height: 44px; margin-top: 14px; border: 0; border-radius: 10px; background: CanvasText; color: Canvas; font: inherit; font-weight: 650; cursor: pointer; }
    .hint { margin: 20px 0 0; font-size: 13px; line-height: 1.5; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  </style>
</head>
<body>
  <main>
    <h1>${product}</h1>
    <p class="subtitle">Connect to this daemon</p>
    ${feedback}
    <form method="post" action="${SPARK_WEB_ACCESS_PATH}" autocomplete="off">
      <input type="hidden" name="returnTo" value="${returnTo}" />
      <label for="spark-access-token">Access token</label>
      <input id="spark-access-token" name="token" type="password" required autofocus spellcheck="false" autocomplete="off" placeholder="sdu_…" />
      <button type="submit">Continue</button>
    </form>
    <p class="hint">Generate a token on the host with <code>spark daemon access create</code>.</p>
  </main>
</body>
</html>`;
}

function normalizeClientAddress(address: string): string {
  const normalized = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .split("%", 1)[0]!;
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
