import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";

import type { ProviderId, ProviderVersion } from "@zendev-lab/spark-lens";
import { afterEach, describe, expect, test } from "vitest";

import { DaemonLensDocumentMirrors } from "./document-mirror.ts";
import { createBrokeredLspProvider } from "./lsp-provider.ts";
import { DaemonLensProcessBroker, type ManagedProviderProcess } from "./provider-process-broker.ts";
import { DaemonLensStateStore } from "./state-store.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";

describe("brokered LSP provider", () => {
  const databases: DatabaseSync[] = [];
  const brokers: DaemonLensProcessBroker[] = [];

  afterEach(async () => {
    await Promise.all(brokers.splice(0).map(async (broker) => await broker.close()));
    for (const db of databases.splice(0)) db.close();
  });

  test("initializes once and sends versioned documents through the isolated mirror", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    migrateSparkDaemonDatabase(db);
    const methods: string[] = [];
    const process = fakeLspProcess(methods);
    const broker = new DaemonLensProcessBroker({
      stateStore: new DaemonLensStateStore(db),
      async launcher() {
        return process;
      },
    });
    brokers.push(broker);
    const providerId = "typescript-7-native" as ProviderId;
    const provider = createBrokeredLspProvider({
      spec: {
        id: providerId,
        kind: "lsp",
        languages: ["typescript"],
        capabilities: [],
      },
      providerVersion: "7.0.2" as ProviderVersion,
      async launch(workspace) {
        return {
          providerId,
          executable: "/spark/managed/tsc",
          args: ["--lsp", "--stdio"],
          cwd: workspace.projectRoot,
          source: "spark_managed",
          executableDigest: "managed-ts7",
          configDigest: workspace.configDigest,
        };
      },
      broker,
      mirrors: new DaemonLensDocumentMirrors(),
    });
    const controller = new AbortController();
    const session = await provider.open(
      {
        worktreeRoot: "/worktrees/a",
        projectRoot: "/worktrees/a",
        workspaceRoot: "/worktrees/a",
        profileDigest: "profile",
        configDigest: "config",
      },
      controller.signal,
    );
    const result = await session.request(
      {
        capability: "diagnostics",
        input: {
          document: {
            uri: "file:///worktrees/a/src/index.ts",
            languageId: "typescript",
            version: 1,
            content: "export const value = 1;",
          },
        },
        revision: {
          schemaVersion: 1,
          workspaceRoot: "/worktrees/a",
          headOid: "abc",
          trackedDiffDigest: "tracked",
          stagedDiffDigest: "staged",
          untrackedContentDigest: "untracked",
          profileDigest: "profile",
          digest: "revision",
          observedAt: "2026-07-31T00:00:00.000Z",
        },
      },
      controller.signal,
    );

    expect(result).toEqual({ kind: "full", items: [] });
    expect(methods).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/diagnostic",
    ]);
    await session.close();
  });
});

function fakeLspProcess(methods: string[]): ManagedProviderProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = Buffer.alloc(0);
  stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/iu.exec(header)?.[1]);
      const messageEnd = headerEnd + 4 + length;
      if (buffer.length < messageEnd) return;
      const message = JSON.parse(buffer.subarray(headerEnd + 4, messageEnd).toString("utf8")) as {
        id?: number;
        method: string;
      };
      buffer = buffer.subarray(messageEnd);
      methods.push(message.method);
      if (message.id === undefined) continue;
      const result =
        message.method === "textDocument/diagnostic"
          ? { kind: "full", items: [] }
          : message.method === "initialize"
            ? { capabilities: { diagnosticProvider: true } }
            : null;
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }), "utf8");
      stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
      stdout.write(body);
    }
  });
  let resolveExit!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveExit = resolve;
  });
  return {
    pid: 501,
    stdin,
    stdout,
    stderr,
    exited,
    async terminate() {
      resolveExit({ code: 0, signal: null });
    },
  };
}
