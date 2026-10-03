import type {
  SparkSessionExportFormat,
  SparkSessionExportResult,
} from "@zendev-lab/spark-protocol";

import type { SparkWebDaemonInvoker } from "./rpc.ts";

export interface SparkWebSessionExport {
  contentType: string;
  filename: string;
  stream: ReadableStream<Uint8Array>;
}

export async function createSparkWebSessionExport(
  sessionId: string,
  format: SparkSessionExportFormat,
  invoke: SparkWebDaemonInvoker,
): Promise<SparkWebSessionExport> {
  const first = await invoke("session.export", { sessionId, format, limit: 50 });
  return {
    contentType: first.contentType,
    filename: first.filename,
    stream: exportStream(first, invoke),
  };
}

export async function collectSparkWebSessionHtml(
  sessionId: string,
  invoke: SparkWebDaemonInvoker,
  maxBytes: number,
): Promise<string> {
  let page = await invoke("session.export", { sessionId, format: "html", limit: 50 });
  const chunks: string[] = [];
  let bytes = 0;
  for (;;) {
    bytes += Buffer.byteLength(page.chunk, "utf8");
    if (bytes > maxBytes) {
      throw new Error(`Local Share exceeds its ${maxBytes} byte in-memory boundary.`);
    }
    chunks.push(page.chunk);
    if (page.complete) return chunks.join("");
    page = await invoke("session.export", {
      sessionId,
      format: "html",
      offset: requireNextOffset(page),
      revision: page.revision,
      limit: 50,
    });
  }
}

function exportStream(
  first: SparkSessionExportResult,
  invoke: SparkWebDaemonInvoker,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let nextPage: SparkSessionExportResult | null = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const page = nextPage;
      if (!page) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(page.chunk));
      if (page.complete) {
        nextPage = null;
        controller.close();
        return;
      }
      try {
        nextPage = await invoke("session.export", {
          sessionId: page.sessionId,
          format: page.format,
          offset: requireNextOffset(page),
          revision: page.revision,
          limit: 50,
        });
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function requireNextOffset(page: SparkSessionExportResult): number {
  if (page.nextOffset === undefined || page.nextOffset <= page.offset) {
    throw new Error("Session export page did not advance its offset.");
  }
  return page.nextOffset;
}
