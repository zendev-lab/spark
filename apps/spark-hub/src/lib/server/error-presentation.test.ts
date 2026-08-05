import { describe, expect, it } from "vitest";
import { INVOCATION_ROUTE_UNAVAILABLE_ERROR_CODE } from "../error-codes";
import { presentHubServerError } from "./error-presentation";

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
