export interface CockpitHealthcheckRequest {
  url: URL;
  headers: Record<string, string>;
}

export function createCockpitHealthcheckRequest(
  env?: Record<string, string | undefined>,
): CockpitHealthcheckRequest;

export function checkCockpitHealth(
  env?: Record<string, string | undefined>,
  fetcher?: typeof fetch,
): Promise<boolean>;
