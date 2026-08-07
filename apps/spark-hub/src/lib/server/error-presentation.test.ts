import { describe, expect, it } from "vitest";
import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "../error-codes";
import {
  HUB_SERVICE_UNAVAILABLE_MESSAGE,
  hubServiceUnavailableResponse,
  presentHubServerError,
} from "./error-presentation";

describe("Hub server error presentation", () => {
  it("turns cross-service invocation ownership into an actionable public error", () => {
    const internalError = new Error("Invocation has no daemon-owned session route.");
    internalError.stack = "private daemon stack";

    const presented = presentHubServerError({
      error: internalError,
      status: 500,
      fallbackMessage: "Internal Error",
      requestId: "msg_other_service",
    });

    expect(presented).toEqual({
      code: INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE,
      message: "This invocation is managed by another Spark service.",
      requestId: "msg_other_service",
    });
    expect(JSON.stringify(presented)).not.toContain("daemon-owned session route");
    expect(JSON.stringify(presented)).not.toContain("private daemon stack");
  });

  it("normalizes dependency outages without exposing internal details", () => {
    const unavailable = new Error("daemon socket /private/path is unavailable");
    unavailable.name = "SparkDaemonUnavailableError";

    const presented = presentHubServerError({
      error: unavailable,
      status: 500,
      fallbackMessage: "Internal Error",
      requestId: "msg_dependency_outage",
    });

    expect(presented).toEqual({
      code: "service_unavailable",
      message: HUB_SERVICE_UNAVAILABLE_MESSAGE,
      requestId: "msg_dependency_outage",
    });
    expect(JSON.stringify(presented)).not.toContain("/private/path");
  });

  it("recognizes canonical uppercase runtime outage reason codes", () => {
    const unavailable = Object.assign(new Error("runtime timeout with private detail"), {
      reasonCode: "COMMAND_RESULT_TIMEOUT",
    });

    expect(
      presentHubServerError({
        error: unavailable,
        status: 500,
        fallbackMessage: "Internal Error",
        requestId: "msg_runtime_timeout",
      }),
    ).toEqual({
      code: "service_unavailable",
      message: HUB_SERVICE_UNAVAILABLE_MESSAGE,
      requestId: "msg_runtime_timeout",
    });
  });

  it("renders retryable dependency outages as no-store 503 responses", async () => {
    const response = hubServiceUnavailableResponse("msg_retryable");

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "service_unavailable",
        message: HUB_SERVICE_UNAVAILABLE_MESSAGE,
        requestId: "msg_retryable",
      },
    });
  });

  it("keeps an unexpected server failure private but traceable", () => {
    const presented = presentHubServerError({
      error: new Error("database password accidentally reached the exception"),
      status: 500,
      fallbackMessage: "Internal Error",
      requestId: "msg_unexpected",
    });

    expect(presented).toEqual({
      code: "unexpected_error",
      message: "Internal Error",
      requestId: "msg_unexpected",
    });
    expect(JSON.stringify(presented)).not.toContain("database password");
  });
});
