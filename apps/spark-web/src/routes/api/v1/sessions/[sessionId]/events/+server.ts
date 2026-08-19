import type { RequestHandler } from "./$types";

import { collectSessionLiveEvents, formatSseFrame } from "$lib/server/sse";

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
      let lastCursor = cursor;
      let timer: ReturnType<typeof setInterval> | undefined;
      const send = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearInterval(timer);
        request.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // Stream already closed by the runtime.
        }
      };
      const pump = async () => {
        const events = await collectSessionLiveEvents({ sessionId, cursor: lastCursor });
        for (const event of events) {
          send(formatSseFrame(event));
          lastCursor = event.cursor;
        }
      };
      request.signal.addEventListener("abort", close);
      void pump()
        .then(() => {
          if (closed) return;
          send(": connected\n\n");
          timer = setInterval(() => {
            void pump().catch(() => undefined);
          }, 750);
        })
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
