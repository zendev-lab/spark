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
}

/**
 * Ask the daemon owner for one process-scoped direct-Web token.
 *
 * Every Web startup issues a fallback token, including loopback-only starts.
 * Actual loopback peers may still use the tokenless fast path, while the
 * printed credential prevents a runtime address-classification mismatch from
 * leaving the listener unreachable. Callers print the plaintext only after
 * their listener is ready and invoke `revoke` during normal shutdown. The
 * helper never generates or persists a competing credential outside the
 * daemon.
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
  let revokePromise: Promise<void> | undefined;
  return {
    token: created.token,
    recordId: created.record.id,
    revoke: () => (revokePromise ??= revoke({ id: created.record.id }).then(() => undefined)),
  };
}
