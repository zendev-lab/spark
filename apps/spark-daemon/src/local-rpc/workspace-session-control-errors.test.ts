import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import { resolveSparkPaths } from "@zendev-lab/spark-system";
import { SparkDaemonLeaseTransferBroker } from "../core/lease-transfer.ts";
import { createDaemonSessionRegistry } from "../session-registry.ts";
import { openSparkDaemonDatabase } from "../store/schema.ts";
import { handleLocalRpcLine } from "./dispatch.ts";
import { createDaemonWorkspaceSession } from "../../../../test/support/session-fixtures.ts";

describe("workspace and session local RPC control errors", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes an unavailable transfer broker from an unknown transfer", async () => {
    const { paths, db } = createFixture(roots);
    try {
      const unavailable = await request(paths, db, "workspace.transfer.respond", {
        transferId: "transfer-unavailable",
        decision: "accept",
        source: "cli",
      });
      expect(unavailable).toMatchObject({
        ok: false,
        error: { code: "workspace_transfer_unavailable" },
      });

      const notFound = await request(
        paths,
        db,
        "workspace.transfer.respond",
        {
          transferId: "transfer-missing",
          decision: "accept",
          source: "cli",
        },
        { leaseTransfers: new SparkDaemonLeaseTransferBroker() },
      );
      expect(notFound).toMatchObject({
        ok: false,
        error: { code: "workspace_transfer_not_found" },
      });
    } finally {
      db.close();
    }
  });

  it("classifies a successful registration response without a workspace binding", async () => {
    const { root, paths, db } = createFixture(roots);
    const workspacePath = join(root, "workspace-register");
    mkdirSync(workspacePath);
    try {
      const response = await request(
        paths,
        db,
        "workspace.register",
        {
          serverUrl: "http://127.0.0.1:5173/",
          localPath: workspacePath,
          displayName: "Missing binding",
          registrationToken: "spark_wsreg_missing_binding",
        },
        {
          ensureSparkDaemonRegistrationForWorkspace: async () => ({
            config: {
              installationId: "installation-test",
              displayName: "Test daemon",
            },
          }),
        },
      );
      expect(response).toMatchObject({
        ok: false,
        error: { code: "workspace_registration_failed" },
      });
    } finally {
      db.close();
    }
  });

  it("reports unavailable session mail capabilities before attempting a mutation", async () => {
    const { paths, db } = createFixture(roots);
    try {
      for (const [method, params] of [
        ["session.inbox", { sessionId: "session-target" }],
        ["session.mail.read", { sessionId: "session-target", messageId: "mail:missing" }],
        ["session.mail.ack", { sessionId: "session-target", messageId: "mail:missing" }],
        [
          "session.send",
          {
            toSessionId: "session-target",
            fromSessionId: "session-origin",
            kind: "request",
            intent: "work.request",
            payload: {},
            idempotencyKey: "mail-store-unavailable",
            body: "investigate",
            origin: { surface: "local", host: "session" },
            source: "tool",
          },
        ],
      ] as const) {
        await expectCode(request(paths, db, method, params), "session_mail_store_unavailable");
      }
    } finally {
      db.close();
    }
  });

  it("exposes actionable session-mail rejections without classifying mailbox corruption", async () => {
    const { root, paths, db } = createFixture(roots);
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    mkdirSync(workspaceA);
    mkdirSync(workspaceB);
    const sparkHome = join(root, ".spark");
    const sessionRegistry = createDaemonSessionRegistry(sparkHome, {
      daemonId: "session-mail-errors",
      daemonCwd: root,
      resolveWorkspaceCwd: (workspaceId) =>
        workspaceId === "workspace-a"
          ? workspaceA
          : workspaceId === "workspace-b"
            ? workspaceB
            : undefined,
    });
    const mailStore = new SparkSessionMailStore({ sparkHome });
    try {
      for (const [sessionId, workspaceId] of [
        ["session-origin", "workspace-a"],
        ["session-target", "workspace-a"],
        ["session-other-workspace", "workspace-b"],
        ["session-archived", "workspace-a"],
        ["session-bound", "workspace-a"],
      ] as const) {
        await createDaemonWorkspaceSession(sessionRegistry, {
          sessionId,
          workspaceId,
        });
      }
      await sessionRegistry.archive("session-archived");
      await sessionRegistry.bind({
        sessionId: "session-bound",
        externalKey: "infoflow:user:bound",
        adapterId: "info-main",
      });

      const base = {
        fromSessionId: "session-origin",
        kind: "request",
        intent: "work.request",
        payload: {},
        body: "investigate",
        origin: { surface: "local", host: "session" },
        wake: true,
        source: "tool",
      } as const;
      const options = { sessionRegistry, mailStore };
      const send = async (idempotencyKey: string, overrides: Record<string, unknown>) =>
        await request(
          paths,
          db,
          "session.send",
          { ...base, toSessionId: "session-target", idempotencyKey, ...overrides },
          options,
        );

      await expectCode(
        send("mail-error:self", {
          toSessionId: "session-origin",
          fromSessionId: "session-origin",
        }),
        "session_mail_self_target",
      );
      await expectCode(
        send("mail-error:binding-required", {
          origin: { surface: "channel", host: "channel" },
        }),
        "session_mail_origin_binding_required",
      );
      await expectCode(
        send("mail-error:scope", {
          toSessionId: "session-other-workspace",
          origin: { surface: "channel", host: "channel" },
          originBinding: {
            workspaceId: "workspace-a",
            adapter: "infoflow",
            adapterId: "info-main",
            externalKey: "infoflow:user:origin",
            recipient: "user:origin",
          },
        }),
        "session_mail_workspace_scope_mismatch",
      );
      await expectCode(
        send("mail-error:archived", { toSessionId: "session-archived" }),
        "session_mail_target_archived",
      );
      await expectCode(
        send("mail-error:bound", { toSessionId: "session-bound" }),
        "session_mail_target_not_local",
      );

      for (const method of [
        "session.mail.read",
        "session.mail.ack",
        "session.notification.deliver",
      ] as const) {
        await expectCode(
          request(
            paths,
            db,
            method,
            { sessionId: "session-target", messageId: "mail:missing" },
            options,
          ),
          "session_mail_not_found",
        );
      }

      const corruptMailboxPath = mailStore.mailboxPath("session-target");
      mkdirSync(dirname(corruptMailboxPath), { recursive: true });
      writeFileSync(corruptMailboxPath, "{not-json", "utf8");
      const corrupt = await request(
        paths,
        db,
        "session.mail.read",
        { sessionId: "session-target", messageId: "mail:any" },
        options,
      );
      expect(corrupt).toMatchObject({
        ok: false,
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Spark daemon request failed.",
        },
      });
      expect(JSON.stringify(corrupt)).not.toContain("not-json");
    } finally {
      db.close();
    }
  });
});

function createFixture(roots: string[]) {
  const root = mkdtempSync(join(tmpdir(), "spark-daemon-control-errors-"));
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
