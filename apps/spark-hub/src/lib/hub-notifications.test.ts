import { describe, expect, it } from "vitest";
import {
  notificationFromHubEvent,
  parseNotificationPreference,
  sanitizeNotificationPayload,
  serializeNotificationPreference,
} from "./hub-notifications";

describe("hub notifications", () => {
  it("maps terminal invocation events to sanitized task notifications", () => {
    expect(
      notificationFromHubEvent({
        kind: "invocation.updated",
        subjectId: "inv_done",
        payload: {
          runtimeInvocationId: "inv_done",
          status: "succeeded",
          terminalReason: "secret detail that must not appear",
          payload: { prompt: "private prompt" },
        },
      }),
    ).toEqual({
      title: "Spark task finished",
      body: "A long-running Spark task completed. Open Hub to review the result.",
      tag: "spark-invocation-inv_done",
      url: "/",
      kind: "task_terminal",
    });

    expect(
      notificationFromHubEvent({
        kind: "invocation.updated",
        subjectId: "inv_failed",
        payload: { runtimeInvocationId: "inv_failed", status: "failed" },
      }),
    ).toMatchObject({
      title: "Spark task needs attention",
      body: "A long-running Spark task stopped or failed. Open Hub to review the status.",
    });
  });

  it("maps human request events to blocker notifications without leaking prompt text", () => {
    expect(
      notificationFromHubEvent({
        kind: "human.request.created",
        subjectId: "hreq_1",
        payload: { runtimeRequestId: "runtime-1", prompt: "private blocker details" },
      }),
    ).toEqual({
      title: "Spark is waiting for you",
      body: "A blocker, approval, or review needs a response in Hub.",
      tag: "spark-blocker-hreq_1",
      url: "/",
      kind: "blocker",
    });
  });

  it("ignores non-notifiable and non-terminal events", () => {
    expect(
      notificationFromHubEvent({
        kind: "invocation.updated",
        subjectId: "inv_running",
        payload: { runtimeInvocationId: "inv_running", status: "running" },
      }),
    ).toBeNull();
    expect(
      notificationFromHubEvent({ kind: "command.queued", subjectId: "cmd_1", payload: {} }),
    ).toBeNull();
  });

  it("sanitizes service-worker push payloads", () => {
    expect(
      sanitizeNotificationPayload({
        title: "  Custom\nTitle ",
        body: "Line one\nline two",
        tag: "custom-tag",
        url: "//evil.test",
        kind: "blocker",
      }),
    ).toEqual({
      title: "Custom Title",
      body: "Line one line two",
      tag: "custom-tag",
      url: "/",
      kind: "blocker",
    });
  });

  it("serializes opt-in notification preferences", () => {
    expect(serializeNotificationPreference(true)).toBe("enabled");
    expect(serializeNotificationPreference(false)).toBe("disabled");
    expect(parseNotificationPreference("enabled")).toBe(true);
    expect(parseNotificationPreference("disabled")).toBe(false);
    expect(parseNotificationPreference(null)).toBe(false);
  });
});
