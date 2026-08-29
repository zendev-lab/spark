const shellCache = "spark-web-static-v1";
const staticPaths = new Set([
  "/manifest.webmanifest",
  "/icons/spark.svg",
  "/icons/spark-maskable.svg",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(shellCache).then((cache) => cache.addAll([...staticPaths])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== shellCache).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const cacheable = url.pathname.startsWith("/_app/immutable/") || staticPaths.has(url.pathname);
  if (cacheable) {
    event.respondWith(
      caches.open(shellCache).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      }),
    );
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(offlinePage(url, request.headers.get("accept-language")), {
            status: 503,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'",
            },
          }),
      ),
    );
  }
});

function offlinePage(url, acceptLanguage) {
  const requestedLocale = url.searchParams.get("lang")?.toLowerCase();
  const locale =
    requestedLocale === "zh-cn" ||
    (!requestedLocale && /(?:^|,)\s*zh(?:-cn)?(?:\s*;|\s*,|$)/iu.test(acceptLanguage ?? ""))
      ? "zh-CN"
      : "en";
  const copy =
    locale === "zh-CN"
      ? {
          title: "Spark 暂时不可用",
          body: "这个页面暂时无法连接到本机上的 Spark。你的对话、产物和凭据不会被离线缓存。",
          impact: "当前影响",
          impactValue: "暂时不能继续对话或执行操作",
          retry: "重新连接",
          steps: "仍然无法连接？",
          stepOne: "确认启动 Spark 的终端窗口仍在运行。",
          stepTwo: "如果进程已经退出，请在工作空间中重新运行 spark web。",
          stepThree: "回到这个页面，再选择“重新连接”。",
          note: "Spark Web 只在本机在线服务可用时读取会话数据。",
        }
      : {
          title: "Spark is temporarily unavailable",
          body: "This page cannot reach Spark on this computer right now. Conversations, Artifacts, and credentials are never cached offline.",
          impact: "Current impact",
          impactValue: "Conversations and execution controls are temporarily unavailable",
          retry: "Reconnect",
          steps: "Still cannot connect?",
          stepOne: "Check that the terminal window running Spark is still open.",
          stepTwo: "If it exited, run spark web again from your Workspace.",
          stepThree: "Return here and choose Reconnect.",
          note: "Spark Web reads Session data only while the local service is online.",
        };

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${copy.title}</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { background: #f8fafc; color: #0f172a; margin: 0; min-height: 100vh; }
      main { margin: 0 auto; max-width: 720px; padding: clamp(24px, 8vh, 76px) 24px 40px; }
      header { align-items: center; display: flex; font-size: 15px; font-weight: 700; gap: 9px; }
      header img { height: 30px; width: 30px; }
      section { border-top: 1px solid #cbd5e1; margin-top: 28px; padding-top: clamp(36px, 8vh, 72px); }
      h1 { font-size: clamp(30px, 6vw, 48px); letter-spacing: -0.035em; line-height: 1.08; margin: 0; max-width: 14ch; }
      .lede { color: #475569; font-size: 16px; line-height: 1.65; margin: 18px 0 0; max-width: 62ch; }
      dl { border-block: 1px solid #e2e8f0; margin: 32px 0 0; padding: 15px 0; }
      dl div { display: grid; gap: 5px; grid-template-columns: minmax(110px, .35fr) minmax(0, 1fr); }
      dt { color: #64748b; font-size: 13px; }
      dd { font-size: 14px; font-weight: 600; margin: 0; }
      .actions { margin-top: 24px; }
      .retry { background: #2563eb; border-radius: 8px; color: white; display: inline-flex; font-size: 14px; font-weight: 650; min-height: 44px; padding: 0 17px; place-items: center; text-decoration: none; }
      .retry:focus-visible { box-shadow: 0 0 0 3px rgba(147, 197, 253, .65); outline: 2px solid #1d4ed8; outline-offset: 2px; }
      details { border-top: 1px solid #e2e8f0; margin-top: 34px; padding-top: 14px; }
      summary { cursor: pointer; font-size: 14px; font-weight: 650; min-height: 44px; padding: 12px 0; }
      ol { color: #475569; line-height: 1.65; margin: 4px 0 0; padding-left: 22px; }
      footer { color: #64748b; font-size: 12px; line-height: 1.5; margin-top: 32px; }
      ::selection { background: #bfdbfe; color: #0f172a; }
      @media (prefers-color-scheme: dark) {
        body { background: #0b1120; color: #f8fafc; }
        section { border-color: #334155; }
        .lede, ol { color: #cbd5e1; }
        dl, details { border-color: #334155; }
        dt, footer { color: #94a3b8; }
      }
      @media (max-width: 520px) { dl div { grid-template-columns: 1fr; } }
    </style>
  </head>
  <body>
    <main>
      <header><img src="/icons/spark.svg" alt=""><span>Spark</span></header>
      <section aria-labelledby="offline-title">
        <h1 id="offline-title">${copy.title}</h1>
        <p class="lede">${copy.body}</p>
        <dl><div><dt>${copy.impact}</dt><dd>${copy.impactValue}</dd></div></dl>
        <div class="actions"><a class="retry" href="">${copy.retry}</a></div>
        <details>
          <summary>${copy.steps}</summary>
          <ol><li>${copy.stepOne}</li><li>${copy.stepTwo}</li><li>${copy.stepThree}</li></ol>
        </details>
        <footer>${copy.note}</footer>
      </section>
    </main>
  </body>
</html>`;
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "spark.notification") return;
  const notification = sanitizeNotification(event.data.notification);
  event.waitUntil(self.registration.showNotification(notification.title, notification.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const client = clients[0];
      if (client) {
        client.navigate?.(url);
        return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

function sanitizeNotification(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    title: safeText(input.title, "Spark update"),
    options: {
      body: safeText(input.body, "Open Spark to review."),
      tag: safeText(input.tag, "spark-web-update"),
      icon: "/icons/spark.svg",
      badge: "/icons/spark-maskable.svg",
      data: { url: safeUrl(input.url) },
    },
  };
}

function safeText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const text = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .trim();
  return text ? text.slice(0, 160) : fallback;
}

function safeUrl(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}
