import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type FetchListener = (event: {
  request: {
    headers: Headers;
    method: string;
    mode: string;
    url: string;
  };
  respondWith(response: Promise<Response> | Response): void;
}) => void;

async function renderOfflinePage(url: string, acceptLanguage = ""): Promise<Response> {
  const source = await readFile(
    fileURLToPath(new URL("../static/service-worker.js", import.meta.url)),
    "utf8",
  );
  const listeners = new Map<string, EventListener>();
  runInNewContext(source, {
    Headers,
    Promise,
    Response,
    URL,
    caches: {},
    fetch: () => Promise.reject(new Error("offline")),
    self: {
      addEventListener(type: string, listener: EventListener) {
        listeners.set(type, listener);
      },
      location: { origin: "http://spark.local" },
      skipWaiting() {},
    },
  });

  let response: Promise<Response> | Response | undefined;
  const listener = listeners.get("fetch") as FetchListener | undefined;
  listener?.({
    request: {
      headers: new Headers({ "accept-language": acceptLanguage }),
      method: "GET",
      mode: "navigate",
      url,
    },
    respondWith(value) {
      response = value;
    },
  });
  if (!response) throw new Error("Service Worker did not handle the navigation request.");
  return response;
}

describe("Spark Web offline recovery", () => {
  it("renders a Chinese, user-facing recovery path without execution-topology language", async () => {
    const response = await renderOfflinePage("http://spark.local/?lang=zh-CN");
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("Spark 暂时不可用");
    expect(html).toContain("重新连接");
    expect(html).not.toMatch(/daemon|Workbench/iu);
  });

  it("uses the request language when the URL does not carry a locale", async () => {
    const response = await renderOfflinePage(
      "http://spark.local/sessions/current",
      "zh-CN,zh;q=0.9",
    );
    const html = await response.text();

    expect(html).toContain('<html lang="zh-CN">');
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
