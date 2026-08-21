import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { FakeChannelTransport, parseChannelsConfig } from "@zendev-lab/dsh-channels";
import type { SparkDaemonTask } from "../core/types.ts";
import { migrateSparkDaemonDatabase } from "../store/schema.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import {
  admitChannelWorkspaceIdentity,
  channelInboundInvocationIdempotencyKey,
  isPermanentWorkspaceIdentityFailure,
  legacyChannelInboundInvocationIdempotencyKey,
  submitChannelInboundInvocation,
} from "./admission.ts";
import { createChannelIngressController, type ChannelIngressAssignment } from "./ingress.ts";
import { applyWorkspaceLifecycleMutation, registerWorkspace } from "../store/workspaces.ts";
import { workspaceSessionRecord } from "../../../../test/support/session-fixtures.ts";

interface ReplayCase {
  name: string;
  adapter: "infoflow" | "qqbot";
  externalKey: string;
  config: ReturnType<typeof parseChannelsConfig>;
  raw(messageId?: string): unknown;
}

const replayCases: ReplayCase[] = [
  {
    name: "Infoflow",
    adapter: "infoflow",
    externalKey: "infoflow:user:user-private",
    config: parseChannelsConfig({
      adapters: { infoflow: { type: "infoflow" } },
      routes: {},
      ingress: { enabled: true, on_unbound: "reject" },
    }),
    raw: (messageId) => ({
      user_id: "user-private",
      text: `message ${messageId ?? "without-id"}`,
      ...(messageId ? { message_id: messageId } : {}),
    }),
  },
  {
    name: "QQ",
    adapter: "qqbot",
    externalKey: "qqbot:c2c:user-private",
    config: parseChannelsConfig({
      adapters: { qqbot: { type: "qqbot", app_id: "app", client_secret: "secret" } },
      routes: {},
      ingress: { enabled: true, on_unbound: "reject" },
    }),
    raw: (messageId) => ({
      event_type: "C2C_MESSAGE_CREATE",
      d: {
        ...(messageId ? { id: messageId } : {}),
        content: `message ${messageId ?? "without-id"}`,
        author: { user_openid: "user-private" },
      },
    }),
  },
];

describe("channel inbound durable admission", () => {
  for (const replayCase of replayCases) {
    it(`deduplicates ${replayCase.name} replay from overlapping ingress transports`, async () => {
      const root = await mkdtemp(join(tmpdir(), "spark-channel-admission-"));
      const databasePath = join(root, "daemon.sqlite");
      const firstDb = new DatabaseSync(databasePath);
      migrateSparkDaemonDatabase(firstDb);
      const secondDb = new DatabaseSync(databasePath);
      migrateSparkDaemonDatabase(secondDb);
      const firstStore = new SparkInvocationStore(firstDb);
      const secondStore = new SparkInvocationStore(secondDb);
      const firstTransport = new FakeChannelTransport();
      const secondTransport = new FakeChannelTransport();
      const invocationIds: string[] = [];
      const session = workspaceSessionRecord({
        sessionId: `session-${replayCase.name.toLowerCase()}`,
        workspaceId: "ws-overlap",
        bindings: [
          {
            kind: "channel" as const,
            adapter: replayCase.adapter,
            externalKey: replayCase.externalKey,
          },
        ],
        createdAt: "2026-07-15T00:00:00.000Z",
        updatedAt: "2026-07-15T00:00:00.000Z",
      });
      const resolveBinding = vi.fn(async () => session);
      const createAssignmentHandler =
        (store: SparkInvocationStore) => async (assignment: ChannelIngressAssignment) => {
          const task: SparkDaemonTask = {
            type: "session.run",
            sessionId: assignment.sessionId,
            prompt: assignment.goal,
            assignment: assignment.assignment,
            workspaceId: "ws-overlap",
            workspaceBindingId: "rtwb-overlap",
            cwd: "/workspace",
            channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
            ...(assignment.channelContext ? { channelContext: assignment.channelContext } : {}),
          };
          invocationIds.push(submitChannelInboundInvocation(store, assignment, task).invocationId);
        };
      const createController = (transport: FakeChannelTransport, store: SparkInvocationStore) =>
        createChannelIngressController({
          sparkHome: "/unused",
          config: replayCase.config,
          hooks: { onAssignment: createAssignmentHandler(store) },
          sessionRegistry: {
            ensureWorkspaceAdministrator: async () =>
              workspaceSessionRecord({
                sessionId: "sess_admin_ws_overlap",
                workspaceId: "ws-overlap",
                administrator: true,
              }),
            resolveBinding,
          },
          workspaceId: "ws-overlap",
          createTransport: () => transport,
        });
      const first = createController(firstTransport, firstStore);
      const second = createController(secondTransport, secondStore);

      try {
        await Promise.all([first.start(), second.start()]);
        firstTransport.emitInbound(replayCase.raw("platform-message-1"));
        secondTransport.emitInbound(replayCase.raw("platform-message-1"));
        await vi.waitFor(() => expect(invocationIds).toHaveLength(2));

        firstTransport.emitInbound(replayCase.raw("platform-message-2"));
        await vi.waitFor(() => expect(invocationIds).toHaveLength(3));

        expect(invocationIds[1]).toBe(invocationIds[0]);
        expect(invocationIds[2]).not.toBe(invocationIds[0]);
        expect(firstStore.listPage({ limit: 10 })).toMatchObject({ total: 2 });

        const records = firstStore.listPage({ limit: 10 }).invocations;
        expect(records.every((record) => record.sourceKind === "channel")).toBe(true);
        expect(records.every((record) => record.workspaceBindingId === "rtwb-overlap")).toBe(true);
        for (const record of records) {
          expect(record.idempotencyKey).not.toContain("user-private");
          expect(record.idempotencyKey).not.toContain("platform-message");
        }
      } finally {
        await Promise.all([first.stop(), second.stop()]);
        secondDb.close();
        firstDb.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("returns the original invocation when mutable admission projection has drifted", () => {
    const assignment = {
      sessionId: "session-original",
      goal: "original message",
      assignment: {
        goal: "original message",
        target: { sessionId: "session-original", workspaceId: "ws-overlap" },
        constraints: [],
        evidence: [],
        source: {
          kind: "channel",
          channel: "qqbot",
          externalRef: "platform-message-stable",
        },
      },
      source: {
        kind: "channel",
        channel: "qqbot",
        externalRef: "platform-message-stable",
      },
      externalKey: "qqbot:c2c:user-private",
      adapterAccountIdentity: "channel-account:qqbot:account-a",
      channelReply: {
        adapter: "qqbot" as const,
        workspaceId: "ws-overlap",
        adapterId: "qqbot",
        recipient: "c2c:user-private",
        externalKey: "qqbot:test:frozen",
      },
      channelContext: {
        externalKey: "qqbot:c2c:user-private",
        senderId: "user-private",
        messageId: "platform-message-stable",
      },
    } satisfies ChannelIngressAssignment;
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const originalTask: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        model: "provider/original",
        cwd: "/workspace/original",
        assignment: assignment.assignment,
        workspaceId: "ws-overlap",
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
        channelContext: assignment.channelContext,
      };
      const replayProjection: SparkDaemonTask = {
        ...originalTask,
        sessionId: "session-raced-binding",
        model: "provider/new-default",
        cwd: "/workspace/new",
      };

      const first = submitChannelInboundInvocation(store, assignment, originalTask);
      const replay = submitChannelInboundInvocation(store, assignment, replayProjection);

      expect(replay.invocationId).toBe(first.invocationId);
      expect(replay.task).toEqual(originalTask);
    } finally {
      db.close();
    }
  });

  it("accepts a matching v1 admission after upgrade without collapsing another account", () => {
    const assignment = {
      sessionId: "session-account-a",
      goal: "account scoped message",
      assignment: {
        goal: "account scoped message",
        target: { sessionId: "session-account-a", workspaceId: "ws-overlap" },
        constraints: [],
        evidence: [],
        source: {
          kind: "channel",
          channel: "qqbot",
          externalRef: "shared-message-id",
        },
      },
      source: { kind: "channel", channel: "qqbot", externalRef: "shared-message-id" },
      externalKey: "qqbot:c2c:shared-user",
      adapterAccountIdentity: "channel-account:qqbot:account-a",
      channelReply: {
        adapter: "qqbot" as const,
        workspaceId: "ws-overlap",
        adapterId: "qqbot-account-a",
        externalKey: "qqbot:c2c:shared-user",
        recipient: "c2c:shared-user",
      },
      channelContext: {
        externalKey: "qqbot:c2c:shared-user",
        senderId: "shared-user",
        messageId: "shared-message-id",
      },
    } satisfies ChannelIngressAssignment;
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const task: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        assignment: assignment.assignment,
        workspaceId: "ws-overlap",
        cwd: "/workspace",
        // v1 rows predate stable account identity, but retained the configured adapter id.
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
        channelContext: assignment.channelContext,
      };
      const legacyKey = legacyChannelInboundInvocationIdempotencyKey(assignment);
      expect(legacyKey).toMatch(/^channel\.inbound:v1:[a-f0-9]{64}$/u);
      const legacy = store.submit({
        sessionId: task.sessionId,
        prompt: task.prompt,
        task,
        sourceKind: "channel",
        idempotencyKey: legacyKey,
      });

      expect(submitChannelInboundInvocation(store, assignment, task).invocationId).toBe(
        legacy.invocationId,
      );

      const otherAccount = {
        ...assignment,
        sessionId: "session-account-b",
        adapterAccountIdentity: "channel-account:qqbot:account-b",
        channelReply: { ...assignment.channelReply, adapterId: "qqbot-account-b" },
      } satisfies ChannelIngressAssignment;
      const otherTask: SparkDaemonTask = {
        ...task,
        sessionId: otherAccount.sessionId,
        channelReply: {
          ...otherAccount.channelReply,
          externalKey: otherAccount.externalKey,
          adapterAccountIdentity: otherAccount.adapterAccountIdentity,
        },
      };
      const admitted = submitChannelInboundInvocation(store, otherAccount, otherTask);
      expect(admitted.invocationId).not.toBe(legacy.invocationId);
      expect(admitted.idempotencyKey).toMatch(/^channel\.inbound:v2:[a-f0-9]{64}$/u);
      expect(store.listPage({ limit: 10 }).total).toBe(2);
    } finally {
      db.close();
    }
  });

  it("resolves ws_* to the unique owning rtwb_* before assignment submit", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-channel-ws-identity-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const localPath = join(root, "owned");
      mkdirSync(localPath);
      const workspace = registerWorkspace(db, {
        serverUrl: "https://hub.example/",
        localPath,
        displayName: "owned",
        serverBindingId: "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });

      const admission = admitChannelWorkspaceIdentity(db, "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(admission).toEqual({
        state: "resolved",
        workspaceBindingId: "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        workspaceId: workspace.id,
        serverWorkspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      expect(isPermanentWorkspaceIdentityFailure(admission)).toBe(false);
      if (admission.state !== "resolved") {
        throw new Error(`expected resolved workspace identity, got ${admission.state}`);
      }

      const store = new SparkInvocationStore(db);
      const assignment = {
        sessionId: "session-ws-identity",
        goal: "route by server workspace id",
        assignment: {
          goal: "route by server workspace id",
          target: {
            sessionId: "session-ws-identity",
            workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
          constraints: [],
          evidence: [],
          source: {
            kind: "channel",
            channel: "qqbot",
            externalRef: "platform-message-ws",
          },
        },
        source: {
          kind: "channel",
          channel: "qqbot",
          externalRef: "platform-message-ws",
        },
        externalKey: "qqbot:c2c:user-private",
        adapterAccountIdentity: "channel-account:qqbot:account-a",
        channelReply: {
          adapter: "qqbot" as const,
          workspaceId: "ws_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          adapterId: "qqbot",
          recipient: "c2c:user-private",
          externalKey: "qqbot:c2c:user-private",
        },
        channelContext: {
          externalKey: "qqbot:c2c:user-private",
          senderId: "user-private",
          messageId: "platform-message-ws",
        },
      } satisfies ChannelIngressAssignment;
      const task: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        assignment: assignment.assignment,
        workspaceId: admission.workspaceId,
        workspaceBindingId: admission.workspaceBindingId,
        cwd: localPath,
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
        channelContext: assignment.channelContext,
      };
      const admitted = submitChannelInboundInvocation(store, assignment, task);
      expect(admitted.workspaceBindingId).toBe("rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      expect(store.listPage({ limit: 10 }).total).toBe(1);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies unknown/ambiguous/unregistered workspace identities as permanent route failures", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-channel-ws-route-"));
    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const firstPath = join(root, "a");
      const secondPath = join(root, "b");
      const retiredPath = join(root, "retired");
      mkdirSync(firstPath);
      mkdirSync(secondPath);
      mkdirSync(retiredPath);
      registerWorkspace(db, {
        serverUrl: "https://hub.example/",
        localPath: firstPath,
        displayName: "a",
        serverBindingId: "rtwb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        serverWorkspaceId: "ws_shared",
      });
      registerWorkspace(db, {
        serverUrl: "https://hub.example/",
        localPath: secondPath,
        displayName: "b",
        serverBindingId: "rtwb_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        serverWorkspaceId: "ws_shared",
      });
      const retired = registerWorkspace(db, {
        serverUrl: "https://hub.example/",
        localPath: retiredPath,
        displayName: "retired",
        serverBindingId: "rtwb_cccccccccccccccccccccccccccccccc",
        serverWorkspaceId: "ws_retired",
      });
      applyWorkspaceLifecycleMutation(db, {
        action: "unregister",
        workspaceId: retired.id,
      });

      const cases = [
        {
          identity: "ws_missing",
          state: "unknown" as const,
          reasonCode: "workspace_identity_unknown" as const,
        },
        {
          identity: "ws_shared",
          state: "ambiguous" as const,
          reasonCode: "workspace_identity_ambiguous" as const,
        },
        {
          identity: "ws_retired",
          state: "unregistered" as const,
          reasonCode: "workspace_identity_unregistered" as const,
        },
      ];
      for (const testCase of cases) {
        const admission = admitChannelWorkspaceIdentity(db, testCase.identity);
        expect(admission).toMatchObject({
          state: testCase.state,
          reasonCode: testCase.reasonCode,
        });
        expect(isPermanentWorkspaceIdentityFailure(admission)).toBe(true);
        expect(admission.workspaceBindingId).toBeUndefined();
      }
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps messages without a platform id on the non-idempotent path", () => {
    const assignment = {
      sessionId: "session-no-id",
      goal: "message without id",
      assignment: {
        goal: "message without id",
        target: { sessionId: "session-no-id", workspaceId: "ws-overlap" },
        constraints: [],
        evidence: [],
        source: { kind: "channel", channel: "infoflow" },
      },
      source: { kind: "channel", channel: "infoflow" },
      externalKey: "infoflow:user:user-private",
      channelReply: {
        adapter: "infoflow" as const,
        workspaceId: "ws-overlap",
        adapterId: "infoflow",
        externalKey: "infoflow:user:user-private",
        recipient: "user-private",
      },
    } satisfies ChannelIngressAssignment;

    expect(channelInboundInvocationIdempotencyKey(assignment)).toBeUndefined();

    const db = new DatabaseSync(":memory:");
    migrateSparkDaemonDatabase(db);
    try {
      const store = new SparkInvocationStore(db);
      const task: SparkDaemonTask = {
        type: "session.run",
        sessionId: assignment.sessionId,
        prompt: assignment.goal,
        assignment: assignment.assignment,
        workspaceId: "ws-overlap",
        cwd: "/workspace",
        channelReply: { ...assignment.channelReply, externalKey: assignment.externalKey },
      };
      const first = submitChannelInboundInvocation(store, assignment, task);
      const second = submitChannelInboundInvocation(store, assignment, task);
      expect(second.invocationId).not.toBe(first.invocationId);
    } finally {
      db.close();
    }
  });
});
