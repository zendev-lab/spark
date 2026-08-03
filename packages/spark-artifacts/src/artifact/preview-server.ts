/// <reference types="node" />

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import type { Artifact, DocumentArtifactBody, PreviewContentFormat } from "./types.ts";
import { renderArtifactPreviewDocument } from "./preview-renderer.ts";

export interface TemporaryArtifactPreview {
  url: string;
  expiresAt: string;
}

interface ActivePreview {
  server: Server;
  createdAt: number;
  expiresAt: number;
  timer: NodeJS.Timeout;
}

const activePreviews = new Set<ActivePreview>();
const maximumActivePreviews = 8;
const defaultPreviewTtlMs = 30 * 60 * 1_000;
const minimumPreviewTtlMs = 60_000;
const maximumPreviewTtlMs = 2 * 60 * 60 * 1_000;

export async function startTemporaryArtifactPreview(
  artifact: Artifact<DocumentArtifactBody>,
  options: { ttlMs?: number } = {},
): Promise<TemporaryArtifactPreview> {
  evictOldPreviews();
  const ttlMs = normalizePreviewTtl(options.ttlMs);
  const token = randomBytes(18).toString("base64url");
  const path = `/preview/${token}`;
  const rendered = renderArtifactPreviewDocument({
    title: artifact.title,
    format: previewFormatForMediaType(artifact.body.mediaType),
    content: artifact.body.content,
  });
  const body = Buffer.from(rendered.html, "utf8");
  const server = createServer((request, response) => {
    const requestPath = request.url?.split("?", 1)[0];
    if ((request.method !== "GET" && request.method !== "HEAD") || requestPath !== path) {
      response.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      response.end("Preview not found.");
      return;
    }
    response.writeHead(200, {
      ...securityHeaders("text/html; charset=utf-8"),
      "Content-Length": String(body.byteLength),
    });
    response.end(request.method === "HEAD" ? undefined : body);
  });

  try {
    await listenOnLoopback(server);
  } catch (error) {
    server.close();
    throw new Error(
      `temporary preview server unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("temporary preview server did not expose a loopback port");
  }
  const now = Date.now();
  const active: ActivePreview = {
    server,
    createdAt: now,
    expiresAt: now + ttlMs,
    timer: setTimeout(() => closePreview(active), ttlMs),
  };
  active.timer.unref();
  activePreviews.add(active);
  server.once("close", () => {
    clearTimeout(active.timer);
    activePreviews.delete(active);
  });

  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    expiresAt: new Date(active.expiresAt).toISOString(),
  };
}

function previewFormatForMediaType(mediaType: string): PreviewContentFormat {
  switch (mediaType) {
    case "text/markdown":
      return "md";
    case "text/mdx":
      return "mdx";
    case "text/html":
      return "html";
    case "application/vnd.a2ui+json":
      return "a2ui";
    case "application/vnd.spark-ui+json":
      return "spark-ui";
    default:
      throw new Error(`document media type is not previewable: ${mediaType}`);
  }
}

export function closeTemporaryArtifactPreviews(): void {
  for (const preview of [...activePreviews]) closePreview(preview);
}

function listenOnLoopback(server: Server) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

function evictOldPreviews(): void {
  const now = Date.now();
  for (const preview of [...activePreviews]) {
    if (preview.expiresAt <= now) closePreview(preview);
  }
  while (activePreviews.size >= maximumActivePreviews) {
    const oldest = [...activePreviews].sort((left, right) => left.createdAt - right.createdAt)[0];
    if (!oldest) break;
    closePreview(oldest);
  }
}

function closePreview(preview: ActivePreview): void {
  clearTimeout(preview.timer);
  activePreviews.delete(preview);
  preview.server.close();
}

function normalizePreviewTtl(value: number | undefined): number {
  const configured =
    value ??
    Number.parseInt(process.env.SPARK_ARTIFACT_PREVIEW_TTL_MS ?? "", 10) ??
    defaultPreviewTtlMs;
  if (!Number.isFinite(configured)) return defaultPreviewTtlMs;
  return Math.max(minimumPreviewTtlMs, Math.min(maximumPreviewTtlMs, Math.round(configured)));
}

function securityHeaders(contentType: string) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy":
      "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
