import type { RequestHandler } from "./$types";

import { formatSseFrame, streamSessionLiveEvents } from "$lib/server/sse";

export const GET: RequestHandler = async ({ params, url, request }) => {
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    return new Response("session id required", { status: 400 });
  }
  const cursor = url.searchParams.get("cursor");
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // Stream already closed by the runtime.
        }
      };
      const pump = async () => {
        send(": connected\n\n");
        for await (const event of streamSessionLiveEvents({
          sessionId,
          cursor,
          signal: request.signal,
        })) {
          send(formatSseFrame(event));
        }
      };
      request.signal.addEventListener("abort", close);
      void pump()
        .then(close)
        .catch((error: unknown) => {
          if (closed) return;
          controller.error(error);
        });
    },
    cancel() {
      // Abort is also observed through request.signal.
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
