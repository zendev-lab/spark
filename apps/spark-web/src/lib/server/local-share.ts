import { randomBytes } from "node:crypto";

import { collectSparkWebSessionHtml } from "./session-export.ts";
import type { SparkWebDaemonInvoker } from "./rpc.ts";

export const SPARK_WEB_LOCAL_SHARE_MAX_BYTES = 16 * 1024 * 1024;
export const SPARK_WEB_LOCAL_SHARE_MAX_ACTIVE = 20;

export class SparkWebLocalShareLimitError extends Error {
  override readonly name = "SparkWebLocalShareLimitError";
}

interface SparkWebLocalShare {
  token: string;
  sessionId: string;
  html: string;
  createdAt: string;
}

const shares = new Map<string, SparkWebLocalShare>();
let pendingShares = 0;

export async function createSparkWebLocalShare(
  sessionId: string,
  invoke: SparkWebDaemonInvoker,
): Promise<Omit<SparkWebLocalShare, "html">> {
  if (shares.size + pendingShares >= SPARK_WEB_LOCAL_SHARE_MAX_ACTIVE) {
    throw new SparkWebLocalShareLimitError(
      `This Spark Web process already has ${SPARK_WEB_LOCAL_SHARE_MAX_ACTIVE} active local shares. Restart Spark Web to clear them.`,
    );
  }
  pendingShares += 1;
  let html: string;
  try {
    html = await collectSparkWebSessionHtml(sessionId, invoke, SPARK_WEB_LOCAL_SHARE_MAX_BYTES);
  } finally {
    pendingShares -= 1;
  }
  const share = {
    token: randomBytes(24).toString("base64url"),
    sessionId,
    html,
    createdAt: new Date().toISOString(),
  };
  shares.set(share.token, share);
  return {
    token: share.token,
    sessionId: share.sessionId,
    createdAt: share.createdAt,
  };
}

export function readSparkWebLocalShare(token: string): SparkWebLocalShare | undefined {
  return shares.get(token);
}

export function clearSparkWebLocalSharesForTest(): void {
  shares.clear();
  pendingShares = 0;
}
