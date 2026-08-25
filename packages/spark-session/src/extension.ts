import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent } from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-text-rendering";
import {
  executeSparkSessionAction,
  type SparkSessionAction,
  type SparkSessionActionDeps,
  type SparkSessionToolContext,
} from "./action-tool.ts";

export interface SparkSessionHostApi {
  registerTool(config: ToolConfig): void;
}

export interface SparkSessionToolOptions {
  deps?: SparkSessionActionDeps;
}

export function registerSparkSessionTool(
  pi: SparkSessionHostApi,
  options: SparkSessionToolOptions = {},
): void {
  pi.registerTool({
    name: "session",
    label: "Session",
    description:
      "Canonical scoped Session capability. Create a static Role first, spawn or fork a Role-bound Session, then send a request to trigger execution.",
    promptGuidelines: [
      "Use session spawn with an exact RoleRef to create an empty child of the current Session. Use session fork to create a child with an independent copy of the current Session's stable transcript prefix. Neither action sends a message or creates an Invocation.",
      "After spawn or fork, use session send with kind=request and toSessionId to trigger the existing mail, wake, Invocation, and idempotency flow.",
      "The Workspace Administrator is persistent and protected. Never attempt to archive, close, or replace it. Administrator delegates execution; it is not an executor.",
      "session list is paginated and labels lifecycle, placement, owner-derived lifetime, Role binding, surface, and Invocation-derived activity. Archived Sessions remain searchable with includeArchived=true and can be restored; closed Sessions are terminal.",
      "session send is one-way. kind=notification persists without triggering the target. kind=request submits immediately only when the local target is idle. If the target is active and onActive is omitted, the send fails without persisting mail; onActive=queue durably FIFO-admits up to three pending requests, and onActive=interrupt cancels current work before submitting. wake=true is optional and legal only for request; the daemon then wakes the sender with a completion summary. Do not wait on send.",
      'Use session({ action: "wait", invocationId, timeoutMs? }) to poll a durable invocation for a terminal result. Timeout stops only the wait. Ask replies are a separate reply-wait, not session wait.',
      'Use session({ action: "lookup", sessionId }) for a bounded peer projection (lifecycle, activity, optional latestInvocation and pendingAsk). lookup does not wait and does not return a Hub snapshot.',
      "Message-platform sessions may use only list/get/send/lookup/wait/inbox/read/ack. Their list/get/send/lookup/wait targets are restricted to the current workspace, and sends require local targets.",
      "inbox/read/ack are current-session-only; inbox supports offset/limit pagination.",
    ],
    policy: sessionToolPolicy("external_write"),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      return action === "list" ||
        action === "get" ||
        action === "inbox" ||
        action === "lookup" ||
        action === "wait"
        ? sessionToolPolicy("read")
        : sessionToolPolicy("external_write");
    },
    parameters: Type.Object({
      action: Type.String({
        description:
          "list | get | spawn | fork | bind | unbind | archive | restore | close | send | lookup | wait | inbox | read | ack",
      }),
      sessionId: Type.Optional(
        Type.String({
          description: "Target for get/bind/unbind/archive/restore/close/lookup/inbox/read/ack.",
        }),
      ),
      workspaceId: Type.Optional(
        Type.String({
          description: "Workspace override for list; defaults to the current workspace.",
        }),
      ),
      includeArchived: Type.Optional(Type.Boolean()),
      query: Type.Optional(
        Type.String({
          description: "Case-insensitive Session id, role, path, archive reason, or tag query.",
        }),
      ),
      tags: Type.Optional(
        Type.Array(Type.String(), {
          description: "Require all exact lifecycle tags for list; add tags for archive.",
        }),
      ),
      reason: Type.Optional(Type.String({ description: "Optional archive reason." })),
      surface: Type.Optional(
        Type.String({ description: "all | local | channel for list. Defaults to all." }),
      ),
      activity: Type.Optional(
        Type.String({ description: "all | idle | running for list. Defaults to all." }),
      ),
      adapter: Type.Optional(
        Type.String({
          description: "all | feishu | infoflow | qqbot for list. Defaults to all.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum rows. Defaults to 20." })),
      offset: Type.Optional(Type.Number({ description: "List offset. Defaults to 0." })),
      name: Type.Optional(Type.String({ description: "Display name for spawn or fork." })),
      roleRef: Type.Optional(
        Type.String({ description: "Exact static RoleRef required for spawn or fork." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory for spawn or fork." })),
      cwdArtifactRef: Type.Optional(
        Type.String({ description: "Optional GitChange root for spawn or fork cwd." }),
      ),
      externalKey: Type.Optional(Type.String()),
      toSessionId: Type.Optional(Type.String({ description: "Target session for send." })),
      kind: Type.Optional(
        Type.String({
          description:
            "request | notification. Defaults to notification; only request triggers target execution.",
        }),
      ),
      onActive: Type.Optional(
        Type.Union([Type.Literal("queue"), Type.Literal("interrupt")], {
          description:
            "Active-target policy for request sends. Omit to fail closed; queue persists up to three FIFO requests, while interrupt cancels current work before submitting.",
        }),
      ),
      wake: Type.Optional(
        Type.Boolean({
          description:
            "Request-only. When true, the daemon wakes the sender with a completion summary after the target invocation finishes. Defaults to false.",
        }),
      ),
      wait: Type.Optional(
        Type.String({
          description: "Retired on send. Use action=wait for invocation polling.",
        }),
      ),
      invocationId: Type.Optional(
        Type.String({
          description: "Required for action=wait. Durable invocation to poll.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Wait timeout in milliseconds (1000-300000). Valid only for action=wait.",
        }),
      ),
      intent: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Any()),
      correlationId: Type.Optional(Type.String()),
      subject: Type.Optional(Type.String()),
      message: Type.Optional(Type.String({ description: "Durable message body for send." })),
      messageId: Type.Optional(Type.String()),
      includeAcked: Type.Optional(Type.Boolean()),
    }),
    renderCall(args) {
      return new SessionToolCallText(
        [
          "session",
          typeof args.action === "string" ? `action=${args.action}` : "action=?",
          typeof args.toSessionId === "string"
            ? `to=${args.toSessionId}`
            : typeof args.sessionId === "string"
              ? args.sessionId
              : undefined,
          typeof args.kind === "string" ? `kind=${args.kind}` : undefined,
          typeof args.onActive === "string" ? `onActive=${args.onActive}` : undefined,
          typeof args.wake === "boolean" ? `wake=${String(args.wake)}` : undefined,
          typeof args.invocationId === "string" ? `invocation=${args.invocationId}` : undefined,
          typeof args.invocationId === "string" ? `invocation=${args.invocationId}` : undefined,
          typeof args.surface === "string" ? `surface=${args.surface}` : undefined,
          typeof args.activity === "string" ? `activity=${args.activity}` : undefined,
        ]
          .filter((value): value is string => Boolean(value))
          .join(" "),
      );
    },
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const action = normalizeSessionAction(params.action);
      return await executeSparkSessionAction(
        {
          action,
          toolCallId,
          params: stripAction(params),
          signal,
          ctx: ctx as SparkSessionToolContext,
        },
        options.deps,
      );
    },
  });
}

function sessionToolPolicy(effect: "read" | "external_write"): NonNullable<ToolConfig["policy"]> {
  return {
    effect,
    executionMode: effect === "read" ? "parallel" : "sequential",
    domains: ["sessions"],
    approval: "none",
  };
}

export default function sparkSessionExtension(api: SparkSessionHostApi): void {
  registerSparkSessionTool(api);
}

class SessionToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

function normalizeSessionAction(value: unknown): SparkSessionAction {
  if (
    value === "list" ||
    value === "get" ||
    value === "spawn" ||
    value === "fork" ||
    value === "bind" ||
    value === "unbind" ||
    value === "archive" ||
    value === "restore" ||
    value === "close" ||
    value === "send" ||
    value === "lookup" ||
    value === "wait" ||
    value === "inbox" ||
    value === "read" ||
    value === "ack"
  )
    return value;
  throw new Error(
    "session.action must be list, get, spawn, fork, bind, unbind, archive, restore, close, send, lookup, wait, inbox, read, or ack",
  );
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}
