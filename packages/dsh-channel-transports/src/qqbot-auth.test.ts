import { describe, expect, it, vi } from "vitest";
import { startQqbotQrAuth, type QqbotQrConnector } from "./qqbot-auth.ts";

describe("startQqbotQrAuth", () => {
  it("keeps console rendering disabled and normalizes connector credentials", () => {
    const dispose = vi.fn();
    let connectorCallbacks: Parameters<QqbotQrConnector>[0] | undefined;
    const connector = vi.fn<QqbotQrConnector>((callbacks) => {
      connectorCallbacks = callbacks;
      return dispose;
    });
    const onQrCode = vi.fn();
    const onSuccess = vi.fn();

    const stop = startQqbotQrAuth(
      {
        onQrCode,
        onSuccess,
        onFailure: vi.fn(),
      },
      { connector },
    );

    expect(stop).toBe(dispose);
    expect(connector).toHaveBeenCalledWith(expect.any(Object), {
      displayQrCodeToConsole: false,
      source: "spark",
    });

    connectorCallbacks?.onQrDisplayed?.("https://q.qq.com/connect");
    connectorCallbacks?.onSuccess([
      { appId: "app-1", appSecret: "secret-1", userOpenid: "user-1" },
    ]);

    expect(onQrCode).toHaveBeenCalledWith("https://q.qq.com/connect");
    expect(onSuccess).toHaveBeenCalledWith([
      { appId: "app-1", clientSecret: "secret-1", userOpenid: "user-1" },
    ]);
  });
});
