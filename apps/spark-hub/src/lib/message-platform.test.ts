import { describe, expect, it } from "vitest";
import {
  daemonMessagePlatformConnections,
  freshMessagePlatformFormValues,
} from "./message-platform";

describe("freshMessagePlatformFormValues", () => {
  it("retains account settings without inventing a conversation binding", () => {
    expect(
      freshMessagePlatformFormValues({
        adapter: "infoflow",
        infoflowDefaultEndpoint: "https://api.im.baidu.com",
        feishuAppId: "cli_stored",
        infoflowAppKey: "stored-key",
        infoflowAppAgentId: "43163",
        qqbotAppId: "qq-stored",
        qqbotSandbox: true,
      }),
    ).toEqual({
      adapter: "infoflow",
      feishuAppId: "cli_stored",
      feishuAppSecret: "",
      infoflowEndpoint: "https://api.im.baidu.com",
      infoflowAppKey: "stored-key",
      infoflowAppAgentId: "43163",
      infoflowAppSecret: "",
      qqbotAppId: "qq-stored",
      qqbotClientSecret: "",
      qqbotSandbox: true,
    });
  });
});

describe("daemonMessagePlatformConnections", () => {
  it("lists one account connection per configured adapter, independent of sessions", () => {
    expect(
      daemonMessagePlatformConnections(
        {
          feishuEnabled: false,
          feishuAppId: "",
          infoflowEnabled: true,
          infoflowAppAgentId: "43163",
          qqbotEnabled: true,
          qqbotAppId: "qq-app",
        },
        [
          { id: "info-primary", type: "infoflow", state: "connected" },
          {
            id: "qq-primary",
            type: "qqbot",
            state: "reconnecting",
            error: "gateway unavailable",
          },
        ],
      ),
    ).toEqual([
      {
        adapter: "infoflow",
        adapterId: "info-primary",
        accountId: "info-primary",
        editable: true,
        runtimeState: "connected",
      },
      {
        adapter: "qqbot",
        adapterId: "qq-primary",
        accountId: "qq-primary",
        editable: true,
        runtimeState: "reconnecting",
        runtimeError: "gateway unavailable",
      },
    ]);
  });

  it("does not expose a credential as the Infoflow account label", () => {
    expect(
      daemonMessagePlatformConnections({
        feishuEnabled: false,
        feishuAppId: "",
        infoflowEnabled: true,
        infoflowAppAgentId: "",
        qqbotEnabled: false,
        qqbotAppId: "",
      }),
    ).toEqual([{ adapter: "infoflow", adapterId: "infoflow", accountId: "", editable: true }]);
  });

  it("keeps same-type runtime accounts separate and disables ambiguous legacy editing", () => {
    expect(
      daemonMessagePlatformConnections(
        {
          feishuEnabled: false,
          feishuAppId: "",
          infoflowEnabled: true,
          infoflowAppAgentId: "legacy-first-account",
          qqbotEnabled: false,
          qqbotAppId: "",
        },
        [
          { id: "info-east", type: "infoflow", state: "connected" },
          { id: "info-west", type: "infoflow", state: "stopped" },
        ],
      ),
    ).toEqual([
      {
        adapter: "infoflow",
        adapterId: "info-east",
        accountId: "info-east",
        editable: false,
        runtimeState: "connected",
      },
      {
        adapter: "infoflow",
        adapterId: "info-west",
        accountId: "info-west",
        editable: false,
        runtimeState: "stopped",
      },
    ]);
  });
});
