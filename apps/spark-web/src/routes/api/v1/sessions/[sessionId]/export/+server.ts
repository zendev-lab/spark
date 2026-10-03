import { error } from "@sveltejs/kit";
import { sparkSessionExportFormatSchema } from "@zendev-lab/spark-protocol";

import { createSparkWebSessionExport } from "$lib/server/session-export";
import { invokeSparkWebRpc } from "$lib/server/rpc";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url }) => {
  const parsed = sparkSessionExportFormatSchema.safeParse(url.searchParams.get("format"));
  if (!parsed.success) error(400, "Export format must be jsonl, json, text, or html.");
  const exported = await createSparkWebSessionExport(
    params.sessionId,
    parsed.data,
    invokeSparkWebRpc,
  );
  return new Response(exported.stream, {
    headers: {
      "content-type": exported.contentType,
      "content-disposition": `attachment; filename="${exported.filename}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
};
