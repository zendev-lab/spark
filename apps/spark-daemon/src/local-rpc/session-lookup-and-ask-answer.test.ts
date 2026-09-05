import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSparkPaths } from "@zendev-lab/spark-platform-node";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { SparkDaemonHumanInteractionBroker } from "../core/human-interactions.ts";
import { SparkDaemonHumanWaitRegistry } from "../core/human-waits.ts";
import { createDaemonSessionRegistry } from "../session-registry.ts";
import { SparkInvocationStore } from "../store/invocations.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { handleLocalRpcLine } from "./dispatch.ts";
import { createDaemonWorkspaceSession } from "../../../../test/support/session-fixtures.ts";

describe("session lookup and session ask answers", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects pending session asks without exposing user waits or snapshots", async () => {
    const { root, paths, db } = createFixture(roots);
    const workspacePath = join(root, "workspace");
    mkdirSync(workspacePath);
    const sparkHome = join(root, ".spark");
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "session-lookup-test",
      daemonCwd: root,
      resolveWorkspaceCwd: () => workspacePath,
    });
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const invocations = new SparkInvocationStore(db);
    try {
      await createDaemonWorkspaceSession(sessionRegistry, {
        sessionId: "sess_peer",
        workspaceId: "workspace-lookup",
        cwd: workspacePath,
      });
      const invocation = invocations.submit({
        sessionId: "sess_peer",
        prompt: "peer work",
        task: { type: "session.run", sessionId: "sess_peer", prompt: "peer work" },
      });
      invocations.claimNext("lookup-executor");
      invocations.complete(invocation.invocationId, {
        status: "succeeded",
        result: { assistantText: "peer finished" },
      });
      waits.register({
        humanRequestId: "hreq-user",
        interactionRequestId: "interaction-user",
        sessionId: "sess_asker",
        invocationId: "inv_asker",
        kind: "ask_user",
        title: "User ask",
        prompt: "For the user",
        respondent: { kind: "user" },
      });
      waits.register({
        humanRequestId: "hreq-session",
        interactionRequestId: "interaction-session",
        sessionId: "sess_asker",
        invocationId: "inv_asker",
        kind: "ask_user",
        title: "Session ask",
        prompt: "For the peer",
        respondent: { kind: "session", sessionId: "sess_peer" },
      });

      const lookedUp = await request(
        paths,
        db,
        "session.lookup",
        { sessionId: "sess_peer" },
        { sessionRegistry, humanWaits: waits },
      );
      expect(lookedUp).toMatchObject({
        ok: true,
        result: {
          sessionId: "sess_peer",
          lifecycle: "open",
          placement: "active",
          latestInvocation: {
            invocationId: invocation.invocationId,
            status: "succeeded",
            summary: "peer finished",
          },
          pendingAsk: {
            humanRequestId: "hreq-session",
            fromSessionId: "sess_asker",
            title: "Session ask",
            status: "pending",
          },
        },
      });
      expect(JSON.stringify(lookedUp)).not.toContain("hreq-user");
      expect(JSON.stringify(lookedUp)).not.toContain("workspace-lookup");
    } finally {
      db.close();
    }
  });

  it("keeps Hub list User-only and forbids mismatched session answers", async () => {
    const { paths, db } = createFixture(roots);
    const waits = new SparkDaemonHumanWaitRegistry(db);
    const broker = new SparkDaemonHumanInteractionBroker({
      db,
      waits,
      getRuntimeId: () => undefined,
    });
    const options = {
      humanWaits: waits,
      respondHumanInteraction: (
        wait: Parameters<typeof broker.respond>[0],
        input: Parameters<typeof broker.respond>[1],
      ) => broker.respond(wait, input),
    };
    try {
      waits.register({
        humanRequestId: "hreq-user",
        interactionRequestId: "interaction-user",
        sessionId: "sess_asker",
        kind: "ask_user",
        title: "User ask",
        prompt: "For the user",
        respondent: { kind: "user" },
      });
      waits.register({
        humanRequestId: "hreq-session",
        interactionRequestId: "interaction-session",
        sessionId: "sess_asker",
        kind: "ask_user",
        title: "Session ask",
        prompt: "For the peer",
        respondent: { kind: "session", sessionId: "sess_peer" },
      });

      const listed = await request(paths, db, "human.interaction.list", {}, options);
      expect(listed).toMatchObject({
        ok: true,
        result: {
          waits: [expect.objectContaining({ humanRequestId: "hreq-user" })],
        },
      });
      expect(JSON.stringify(listed)).not.toContain("hreq-session");

      await expectCode(
        request(
          paths,
          db,
          "human.interaction.respond",
          {
            interactionRequestId: "interaction-user",
            respondentSessionId: "sess_peer",
            status: "answered",
            provenance: "session",
            answers: { decision: "yes" },
          },
          options,
        ),
        "human_interaction_forbidden",
      );
      await expectCode(
        request(
          paths,
          db,
          "human.interaction.respond",
          {
            interactionRequestId: "interaction-session",
            status: "answered",
            provenance: "session",
            answers: { decision: "yes" },
          },
          options,
        ),
        "human_interaction_forbidden",
      );
      await expectCode(
        request(
          paths,
          db,
          "human.interaction.respond",
          {
            interactionRequestId: "interaction-session",
            respondentSessionId: "sess_other",
            status: "answered",
            provenance: "session",
            answers: { decision: "yes" },
          },
          options,
        ),
        "human_interaction_forbidden",
      );
      await expectCode(
        request(
          paths,
          db,
          "human.interaction.respond",
          {
            interactionRequestId: "interaction-session",
            status: "answered",
            provenance: "direct_user",
            answers: { decision: "yes" },
          },
          options,
        ),
        "human_interaction_forbidden",
      );

      const answered = await request(
        paths,
        db,
        "human.interaction.respond",
        {
          interactionRequestId: "interaction-session",
          respondentSessionId: "sess_peer",
          status: "answered",
          provenance: "session",
          answers: { decision: "yes" },
        },
        options,
      );
      expect(answered).toMatchObject({
        ok: true,
        result: { outcome: "accepted" },
      });
      expect(waits.listEvidenceAnswerEvents("hreq-session")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("isolates channel peer operations by immutable account and external identity", async () => {
    const { root, paths, db } = createFixture(roots);
    const sparkHome = join(root, ".spark");
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "channel-principal-test",
      daemonCwd: root,
      resolveChannelSessionCwd: async (sessionId) => {
        const cwd = join(root, "channels", sessionId);
        mkdirSync(cwd, { recursive: true });
        return cwd;
      },
    });
    const caller = await sessionRegistry.resolveChannelSession({
      adapterAccountIdentity: "account:a",
      adapterId: "info-a",
      externalKey: "infoflow:user:shared",
    });
    const otherAccount = await sessionRegistry.resolveChannelSession({
      adapterAccountIdentity: "account:b",
      adapterId: "info-b",
      externalKey: "infoflow:user:shared",
    });
    const otherExternalKey = await sessionRegistry.resolveChannelSession({
      adapterAccountIdentity: "account:a",
      adapterId: "info-a",
      externalKey: "infoflow:user:other",
    });
    const invocations = new SparkInvocationStore(db);
    const ownInvocation = invocations.submit({
      sessionId: caller.sessionId,
      prompt: "own work",
      task: { type: "session.run", sessionId: caller.sessionId, prompt: "own work" },
    });
    invocations.claimNext("channel-principal-executor");
    invocations.complete(ownInvocation.invocationId, {
      status: "succeeded",
      result: { assistantText: "own result" },
    });
    const foreignInvocation = invocations.submit({
      sessionId: otherExternalKey.sessionId,
      prompt: "foreign work",
      task: {
        type: "session.run",
        sessionId: otherExternalKey.sessionId,
        prompt: "foreign work",
      },
    });
    invocations.claimNext("channel-principal-executor");
    invocations.complete(foreignInvocation.invocationId, {
      status: "succeeded",
      result: { assistantText: "foreign secret" },
    });
    const options = {
      sessionRegistry,
      mailStore: new SparkSessionMailStore({ sparkHome }),
    };

    try {
      const listed = await request(
        paths,
        db,
        "session.list",
        { scope: { kind: "daemon" }, callerSessionId: caller.sessionId },
        options,
      );
      expect(listed).toMatchObject({
        ok: true,
        result: [{ sessionId: caller.sessionId }],
      });
      expect(JSON.stringify(listed)).not.toContain(otherAccount.sessionId);
      expect(JSON.stringify(listed)).not.toContain(otherExternalKey.sessionId);

      for (const [method, params] of [
        ["session.get", { sessionId: otherAccount.sessionId, callerSessionId: caller.sessionId }],
        [
          "session.lookup",
          { sessionId: otherExternalKey.sessionId, callerSessionId: caller.sessionId },
        ],
        [
          "turn.status",
          { invocationId: foreignInvocation.invocationId, callerSessionId: caller.sessionId },
        ],
        [
          "turn.result",
          { invocationId: foreignInvocation.invocationId, callerSessionId: caller.sessionId },
        ],
      ] as const) {
        await expectCode(request(paths, db, method, params, options), "session_scope_mismatch");
      }

      const ownResult = await request(
        paths,
        db,
        "turn.result",
        { invocationId: ownInvocation.invocationId, callerSessionId: caller.sessionId },
        options,
      );
      expect(ownResult).toMatchObject({
        ok: true,
        result: { assistantText: "own result" },
      });

      await expectCode(
        request(
          paths,
          db,
          "session.send",
          {
            toSessionId: otherAccount.sessionId,
            fromSessionId: caller.sessionId,
            kind: "request",
            intent: "work.request",
            payload: {},
            idempotencyKey: "channel-cross-principal",
            body: "interrupt foreign work",
            origin: { surface: "channel", host: "channel" },
            originBinding: {
              adapter: "infoflow",
              adapterId: "info-a",
              adapterAccountIdentity: "account:a",
              externalKey: "infoflow:user:shared",
              recipient: "user:shared",
            },
            onActive: "interrupt",
            source: "tool",
          },
          options,
        ),
        "session_mail_workspace_scope_mismatch",
      );
      await expectCode(
        request(
          paths,
          db,
          "session.send",
          {
            toSessionId: otherAccount.sessionId,
            fromSessionId: caller.sessionId,
            kind: "notification",
            intent: "session.notification",
            payload: {},
            idempotencyKey: "channel-origin-spoof",
            body: "persist foreign mail",
            origin: { surface: "local", host: "session" },
            source: "tool",
          },
          options,
        ),
        "session_mail_origin_binding_required",
      );
      expect(await options.mailStore.list(otherAccount.sessionId, { includeAcked: true })).toEqual(
        [],
      );
    } finally {
      db.close();
    }
  });
});

function createFixture(roots: string[]) {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-session-lookup-"));
  roots.push(root);
  const paths = resolveSparkPaths({
    app: "daemon",
    env: { HOME: root },
    overrides: {
      dataDir: join(root, "data"),
      cacheDir: join(root, "cache"),
      stateDir: join(root, "state"),
      runtimeDir: join(root, "run"),
    },
  });
  return { root, paths, db: openSparkDaemonDatabase(paths) };
}

async function request(
  paths: ReturnType<typeof resolveSparkPaths>,
  db: ReturnType<typeof openSparkDaemonDatabase>,
  method: string,
  params: Record<string, unknown>,
  options: Parameters<typeof handleLocalRpcLine>[4] = {},
) {
  return await handleLocalRpcLine(
    JSON.stringify({ id: `${method}:test`, method, params }),
    paths,
    db,
    undefined,
    options,
  );
}

async function expectCode(response: Promise<unknown>, code: string): Promise<void> {
  await expect(response).resolves.toMatchObject({
    ok: false,
    error: { code },
  });
}
