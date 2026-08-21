import type { QqbotQrAuthCallbacks } from "@zendev-lab/dsh-channels/qqbot-auth";
import { describe, expect, it, vi } from "vitest";
import { createDaemonQqbotQrAuthManager, mergeQqbotQrCredentials } from "./qqbot-auth.ts";

describe("daemon QQ Bot QR auth", () => {
  it("persists connector credentials in daemon config without projecting the secret", async () => {
    let callbacks: QqbotQrAuthCallbacks | undefined;
    const configure = vi.fn(async () => undefined);
    const manager = createDaemonQqbotQrAuthManager({
      loadConfig: async () => null,
      configure,
      startAuth: (next) => {
        callbacks = next;
        return vi.fn();
      },
    });

    const starting = manager.start("ws_0123456789abcdef0123456789abcdef");
    callbacks?.onQrCode("https://q.qq.com/qqbot/openclaw/connect.html?task_id=task-1&source=spark");
    const pending = await starting;
    expect(pending).toMatchObject({ status: "pending" });

    callbacks?.onSuccess([
      { appId: "app-1", clientSecret: "never-project-this", userOpenid: "user-1" },
    ]);
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    const completed = manager.status(pending.workspaceId, pending.id);

    expect(completed).toMatchObject({ status: "succeeded", appId: "app-1" });
    expect(JSON.stringify(completed)).not.toContain("never-project-this");
    expect(configure).toHaveBeenCalledWith(
      pending.workspaceId,
      expect.objectContaining({
        adapters: {
          qqbot: expect.objectContaining({
            type: "qqbot",
            app_id: "app-1",
            client_secret: "never-project-this",
            api_environment: "production",
            allowed_user_ids: ["user-1"],
            group_policy: "disabled",
          }),
        },
      }),
    );
  });

  it("cancels a pending connector session", async () => {
    let callbacks: QqbotQrAuthCallbacks | undefined;
    const dispose = vi.fn();
    const manager = createDaemonQqbotQrAuthManager({
      loadConfig: async () => null,
      configure: async () => undefined,
      startAuth: (next) => {
        callbacks = next;
        return dispose;
      },
    });

    const starting = manager.start("workspace-1");
    callbacks?.onQrCode("https://q.qq.com/connect?task_id=task-1");
    const pending = await starting;

    expect(manager.cancel("workspace-1", pending.id).status).toBe("cancelled");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("publishes only a stable reason when saving credentials fails", async () => {
    let callbacks: QqbotQrAuthCallbacks | undefined;
    const manager = createDaemonQqbotQrAuthManager({
      loadConfig: async () => null,
      configure: async () => {
        throw new Error("provider echoed secret-value");
      },
      startAuth: (next) => {
        callbacks = next;
        return vi.fn();
      },
    });

    const starting = manager.start("workspace-1");
    callbacks?.onQrCode("https://q.qq.com/connect?task_id=task-1");
    const pending = await starting;
    callbacks?.onSuccess([{ appId: "app-1", clientSecret: "secret-value" }]);

    await vi.waitFor(() => {
      expect(manager.status("workspace-1", pending.id)).toMatchObject({
        status: "failed",
        reason: "configuration_failed",
      });
    });
    expect(JSON.stringify(manager.status("workspace-1", pending.id))).not.toContain("secret-value");
  });

  it("does not start another workspace flow while credentials are being saved", async () => {
    let callbacks: QqbotQrAuthCallbacks | undefined;
    let resolveLoad!: () => void;
    const loading = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const manager = createDaemonQqbotQrAuthManager({
      loadConfig: async () => {
        await loading;
        return null;
      },
      configure: async () => undefined,
      startAuth: (next) => {
        callbacks = next;
        return vi.fn();
      },
    });

    const starting = manager.start("workspace-1");
    callbacks?.onQrCode("https://q.qq.com/connect?task_id=task-1");
    const pending = await starting;
    callbacks?.onSuccess([{ appId: "app-1", clientSecret: "secret-value" }]);

    await expect(manager.start("workspace-1")).rejects.toThrow("still being saved");
    resolveLoad();
    await loading;
    await vi.waitFor(() =>
      expect(manager.status("workspace-1", pending.id).status).toBe("succeeded"),
    );
  });

  it("does not configure channels after the manager is stopped during credential loading", async () => {
    let callbacks: QqbotQrAuthCallbacks | undefined;
    let resolveLoad!: () => void;
    const loading = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    const configure = vi.fn(async () => undefined);
    const manager = createDaemonQqbotQrAuthManager({
      loadConfig: async () => {
        await loading;
        return null;
      },
      configure,
      startAuth: (next) => {
        callbacks = next;
        return vi.fn();
      },
    });

    const starting = manager.start("workspace-1");
    callbacks?.onQrCode("https://q.qq.com/connect?task_id=task-1");
    const pending = await starting;
    callbacks?.onSuccess([{ appId: "app-1", clientSecret: "secret-value" }]);
    manager.stop();
    resolveLoad();
    await loading;
    await Promise.resolve();

    expect(manager.status("workspace-1", pending.id).status).toBe("cancelled");
    expect(configure).not.toHaveBeenCalled();
    await expect(manager.start("workspace-1")).rejects.toThrow("manager is stopped");
  });
});

describe("mergeQqbotQrCredentials", () => {
  it("preserves routes and policy while replacing official bot credentials", () => {
    const merged = mergeQqbotQrCredentials(
      {
        adapters: {
          "qq-main": {
            type: "qqbot",
            app_id: "old-app",
            client_secret: "old-secret",
            api_environment: "sandbox",
            allowed_user_ids: ["existing-user"],
            group_policy: "allowlist",
            allowed_group_ids: ["group-1"],
          },
        },
        routes: { alerts: { adapter: "qq-main", recipient: "c2c:user" } },
        ingress: { enabled: false, on_unbound: "reject" },
      },
      { appId: "new-app", clientSecret: "new-secret", userOpenid: "scanner" },
    );

    expect(merged).toEqual({
      adapters: {
        "qq-main": {
          type: "qqbot",
          app_id: "new-app",
          client_secret: "new-secret",
          connection_mode: "websocket",
          api_environment: "production",
          allowed_user_ids: ["existing-user"],
          group_policy: "allowlist",
          group_trigger: "mention",
          allowed_group_ids: ["group-1"],
        },
      },
      routes: { alerts: { adapter: "qq-main", recipient: "c2c:user" } },
      ingress: { enabled: true, on_unbound: "reject" },
    });
  });
});
