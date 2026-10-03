/**
 * Equal-jitter retry delay. The supplied delay is the exponential-backoff
 * ceiling; each attempt waits between 50% and 100% of it so multiple daemon
 * instances do not reconnect in lockstep.
 */
export function reconnectDelayWithJitter(
  ceilingMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.max(1, Math.floor(ceilingMs));
  if (!Number.isFinite(ceiling)) {
    throw new RangeError("ceilingMs must be finite");
  }
  const sample = random();
  if (!Number.isFinite(sample)) {
    throw new RangeError("random() must return a finite number");
  }
  const clampedSample = Math.max(0, Math.min(1, sample));
  return Math.max(1, Math.floor(ceiling * (0.5 + clampedSample * 0.5)));
}

/** Select a one-based reconnect schedule entry and apply equal jitter. */
export function scheduledReconnectDelayWithJitter(
  attempt: number,
  ceilings: readonly number[],
  random: () => number = Math.random,
): number {
  if (ceilings.length === 0) {
    throw new RangeError("ceilings must contain at least one value");
  }
  if (!Number.isFinite(attempt)) {
    throw new RangeError("attempt must be finite");
  }
  const index = Math.min(Math.max(0, Math.floor(attempt) - 1), ceilings.length - 1);
  const ceiling = ceilings[index]!;
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    throw new RangeError(`ceilings[${index}] must be a finite non-negative number`);
  }
  return reconnectDelayWithJitter(ceiling, random);
}
