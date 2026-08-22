export const sparkAgentsHubSource = "agents-hub" as const;

export const sparkCommandPayloadSourceOptions = [sparkAgentsHubSource] as const;

export type SparkCommandPayloadSource = (typeof sparkCommandPayloadSourceOptions)[number];

export function isSparkCommandPayloadSource(value: unknown): value is SparkCommandPayloadSource {
  return sparkCommandPayloadSourceOptions.includes(value as SparkCommandPayloadSource);
}
