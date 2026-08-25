import { preflightRuntimeRelocation } from "@zendev-lab/spark-hub-coordination/runtime-registration";
import {
  RuntimeRelocationPreflightError,
  RuntimeTokenRefreshError,
} from "@zendev-lab/spark-hub-coordination/runtime-registration";
import { readHubInstanceId } from "@zendev-lab/spark-hub-storage-sqlite";

import { getDatabase } from "./db";

export { RuntimeRelocationPreflightError, RuntimeTokenRefreshError };

/** Hub-owned access to the persisted instance identity. */
export function hubRuntimeRelocationInstanceId(): string | null {
  return readHubInstanceId(getDatabase());
}

/** Run relocation preflight against the Hub-owned database connection. */
export function preflightHubRuntimeRelocation(
  input: Parameters<typeof preflightRuntimeRelocation>[1],
): ReturnType<typeof preflightRuntimeRelocation> {
  return preflightRuntimeRelocation(getDatabase(), input);
}
