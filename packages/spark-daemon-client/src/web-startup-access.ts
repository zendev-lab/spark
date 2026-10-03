import { requestSparkDaemon } from "./daemon-client.ts";

interface SparkWebStartupTokenCreateResult {
  token: string;
  record: { id: string };
}

export interface SparkWebStartupAccessToken {
  token: string;
  recordId: string;
  revoke(): Promise<void>;
}

export interface SparkWebStartupAccessTokenOptions {
  create?: (input: { label: string }) => Promise<SparkWebStartupTokenCreateResult>;
  revoke?: (input: { id: string }) => Promise<unknown>;
  /** Test seam; production retries transient shutdown failures after these delays. */
  revokeRetryDelaysMs?: readonly number[];
}

/**
 * Ask the daemon owner for one process-scoped direct-Web token.
 *
 * Every Web startup issues the token required for normal workbench access,
 * including loopback-only starts. Callers print the plaintext only after their
 * listener is ready and invoke `revoke` during normal shutdown. The helper
 * never generates or persists a competing credential outside the daemon.
 */
export async function createSparkWebStartupAccessToken(
  label: string,
  options: SparkWebStartupAccessTokenOptions = {},
): Promise<SparkWebStartupAccessToken> {
  const normalizedLabel = label.trim();
  if (!normalizedLabel) throw new Error("Spark Web startup access token requires a label.");
  const create =
    options.create ??
    (async (input: { label: string }) => await requestSparkDaemon("daemon.access.create", input));
  const revoke =
    options.revoke ??
    (async (input: { id: string }) => await requestSparkDaemon("daemon.access.revoke", input));
  const created = await create({ label: normalizedLabel });
  const revokeRetryDelaysMs = options.revokeRetryDelaysMs ?? [100, 300];
  let revokePromise: Promise<void> | undefined;
  let revoked = false;
  return {
    token: created.token,
    recordId: created.record.id,
    revoke: () => {
      if (revoked) return Promise.resolve();
      return (revokePromise ??= revokeWithRetry(
        revoke,
        { id: created.record.id },
        revokeRetryDelaysMs,
      ).then(
        () => {
          revoked = true;
        },
        (error: unknown) => {
          revokePromise = undefined;
          throw error;
        },
      ));
    },
  };
}

async function revokeWithRetry(
  revoke: (input: { id: string }) => Promise<unknown>,
  input: { id: string },
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await revoke(input);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined) throw error;
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }
}
