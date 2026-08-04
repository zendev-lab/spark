import { describe, expect, it } from "vitest";
import { parseSparkQqbotQrAuthFlow } from "./channel-control.ts";

describe("QQ Bot QR auth flow", () => {
  const flow = {
    id: "qrauth_0123456789abcdef0123456789abcdef",
    workspaceId: "ws_0123456789abcdef0123456789abcdef",
    status: "pending",
    qrCodeUrl: "https://q.qq.com/qqbot/openclaw/connect.html?task_id=task",
    createdAt: "2026-08-03T12:00:00.000Z",
    updatedAt: "2026-08-03T12:00:00.000Z",
  };

  it("accepts the official HTTPS binding origin", () => {
    expect(parseSparkQqbotQrAuthFlow(flow)).toEqual(flow);
  });

  it.each([
    "http://q.qq.com/qqbot/connect",
    "https://example.com/qqbot/connect",
    "javascript:alert(1)",
  ])("rejects an untrusted QR URL: %s", (qrCodeUrl) => {
    expect(() => parseSparkQqbotQrAuthFlow({ ...flow, qrCodeUrl })).toThrow();
  });
});
