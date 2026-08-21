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
          new Response(
            "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Spark unavailable</title><main><h1>Spark daemon unavailable</h1><p>Reconnect to the daemon to use this Workbench. Session, Artifact, and credential data are never cached offline.</p></main>",
            {
              status: 503,
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
              },
            },
          ),
      ),
    );
  }
});

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
