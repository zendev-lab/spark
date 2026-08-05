export interface HubHealthcheckRequest {
  url: URL;
  headers: Record<string, string>;
}

export function createHubHealthcheckRequest(
  env?: Record<string, string | undefined>,
): HubHealthcheckRequest;

export function checkHubHealth(
  env?: Record<string, string | undefined>,
  fetcher?: typeof fetch,
): Promise<boolean>;
