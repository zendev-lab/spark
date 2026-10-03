import { describe, expect, it } from "vitest";

import { createLocalWebFetchProvider } from "./content.ts";

describe("local web fetch response bounds", () => {
  it("cancels the response stream as soon as the byte limit is reached", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode("éé"));
        if (pulls === 100) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = createLocalWebFetchProvider({
      allowPrivateHosts: true,
      maxBytes: 5,
      fetcher: async () =>
        new Response(body, {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        }),
    });

    const result = await provider.fetch({ url: "https://example.com/large" });

    expect(result.truncated).toBe(true);
    expect(result.body.content).toContain("éé");
    expect(result.body.content).toContain("[truncated after 5 bytes]");
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(100);
  });

  it("keeps complete multibyte content when it fits the byte limit", async () => {
    const provider = createLocalWebFetchProvider({
      allowPrivateHosts: true,
      maxBytes: 6,
      fetcher: async () =>
        new Response("历史", {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        }),
    });

    const result = await provider.fetch({ url: "https://example.com/small" });

    expect(result).toMatchObject({
      truncated: false,
      body: { kind: "text", content: "历史" },
    });
  });
});
