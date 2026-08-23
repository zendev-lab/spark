import { DatabaseSync } from "node:sqlite";
import {
  FakeChannelTransport,
  type QqbotTransportOptions,
} from "@zendev-lab/dsh-channel-transports";
import { describe, expect, it, vi } from "vitest";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { createDaemonChannelTransportFactory } from "./transport-factory.ts";

describe("createDaemonChannelTransportFactory", () => {
  it("injects a cursor scoped by provider account identity into rebuilt QQ transports", async () => {
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    const createdOptions: QqbotTransportOptions[] = [];
    const createQqbotTransport = vi.fn((_config, options: QqbotTransportOptions) => {
      createdOptions.push(options);
      return new FakeChannelTransport();
    });
    const factory = createDaemonChannelTransportFactory(db, { createQqbotTransport });
    try {
      expect(
        factory("qq-main", {
          type: "qqbot",
          app_id: "app",
          client_secret: "secret",
        }),
      ).toBeInstanceOf(FakeChannelTransport);
      await createdOptions[0]?.saveCursor?.({ sessionId: "gateway-session", lastSeq: 12 });

      factory("qq-main", {
        type: "qqbot",
        app_id: "app",
        client_secret: "secret",
      });
      expect(await createdOptions[1]?.loadCursor?.()).toEqual({
        sessionId: "gateway-session",
        lastSeq: 12,
      });

      factory("qq-renamed", {
        type: "qqbot",
        app_id: "app",
        client_secret: "rotated",
      });
      expect(await createdOptions[2]?.loadCursor?.()).toEqual({
        sessionId: "gateway-session",
        lastSeq: 12,
      });
      expect(factory("info-main", { type: "infoflow" })).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
