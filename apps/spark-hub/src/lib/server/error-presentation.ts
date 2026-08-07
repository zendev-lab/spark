import {
  HubLayoutMigrationConflictError,
  HubLayoutMigrationLockedError,
} from "@zendev-lab/spark-hub-db";
import {
  SparkDaemonLocalRpcUnavailableError,
  SparkDaemonPreDispatchUnavailableError,
  SparkDaemonProtocolMismatchError,
} from "@zendev-lab/spark-daemon-client";
import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "../error-codes";

const INVOCATION_ROUTE_UNAVAILABLE_MESSAGE = "Invocation has no daemon-owned session route.";
export const HUB_SERVICE_UNAVAILABLE_MESSAGE =
  "Spark Hub dependencies are temporarily unavailable.";

export function presentHubServerError(input: {
  error: unknown;
  status: number;
  fallbackMessage: string;
  requestId: string;
}): App.Error {
  if (isInvocationRouteUnavailableError(input.error)) {
    return {
      code: INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE,
      message: "This invocation is managed by another Spark service.",
      requestId: input.requestId,
    };
  }

  if (isHubServiceUnavailableError(input.error)) {
    return {
      code: "service_unavailable",
      message: HUB_SERVICE_UNAVAILABLE_MESSAGE,
      requestId: input.requestId,
    };
  }

  return {
    code: "unexpected_error",
    message: input.fallbackMessage || `Spark Hub request failed (${input.status}).`,
    requestId: input.requestId,
  };
}

export function isHubServiceUnavailableError(error: unknown): boolean {
  if (
    error instanceof HubLayoutMigrationConflictError ||
    error instanceof HubLayoutMigrationLockedError ||
    error instanceof SparkDaemonLocalRpcUnavailableError ||
    error instanceof SparkDaemonPreDispatchUnavailableError ||
    error instanceof SparkDaemonProtocolMismatchError
  ) {
    return true;
  }
  if (!(error instanceof Error)) return false;
  return (
    error.name === "HubLayoutMigrationConflictError" ||
    error.name === "HubLayoutMigrationLockedError" ||
    error.name === "HubRuntimeSessionUnavailableError" ||
    error.name === "SparkDaemonUnavailableError" ||
    error.name === "SparkDaemonPreDispatchUnavailableError" ||
    error.name === "SparkDaemonProtocolMismatchError" ||
    ("reasonCode" in error &&
      ["runtime_unavailable", "runtime_offline", "command_result_timeout"].includes(
        String(error.reasonCode).toLowerCase(),
      ))
  );
}

export function hubServiceUnavailableResponse(requestId: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "service_unavailable",
        message: HUB_SERVICE_UNAVAILABLE_MESSAGE,
        requestId,
      },
    }),
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        "retry-after": "5",
      },
    },
  );
}

function isInvocationRouteUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(INVOCATION_ROUTE_UNAVAILABLE_MESSAGE);
}
