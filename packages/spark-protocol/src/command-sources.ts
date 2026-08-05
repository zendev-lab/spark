/** Historical wire value retained for N-1 daemon compatibility. */
export const sparkAgentsHubSource = "agents-cockpit" as const;
/** @deprecated Use sparkAgentsHubSource; the serialized value remains frozen. */
export const sparkAgentsCockpitSource = sparkAgentsHubSource;

export const sparkCommandPayloadSourceOptions = [sparkAgentsHubSource] as const;

export type SparkCommandPayloadSource = (typeof sparkCommandPayloadSourceOptions)[number];

export function isSparkCommandPayloadSource(value: unknown): value is SparkCommandPayloadSource {
  return sparkCommandPayloadSourceOptions.includes(value as SparkCommandPayloadSource);
}
