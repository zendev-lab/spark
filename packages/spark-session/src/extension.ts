import { Type } from "typebox";
import type { ToolConfig, ToolRenderComponent } from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-text";
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
      "Canonical scoped Session capability. A Session is an owned execution context; Role binding is an optional behavior type, and the Workspace Administrator is the only persistent Session.",
    promptGuidelines: [
      "Use session create to instantiate a scoped child or sibling under an existing supervising Session. Give it an independent name and choose roleBinding=none, inherit, or an explicit RoleRef; none is the default and adds no Role prompt or Role capability ceiling.",
      "The Workspace Administrator is persistent and protected. Never attempt to archive, close, or replace it. Administrator delegates execution; it is not an executor.",
      "session list is paginated and labels lifecycle, placement, owner-derived lifetime, Role binding, surface, and Invocation-derived activity. Archived Sessions remain searchable with includeArchived=true and can be restored; closed Sessions are terminal.",
      "session send kind=notification persists without triggering the target session; it is the default and cannot wait for completion.",
      "session send kind=request persists and submits one turn to an idle or running local target. wait=accepted is asynchronous and is the default; when the target finishes, the daemon wakes the sender session with a completion summary turn so it can synthesize immediately. wait=completed polls the durable invocation through restart and returns its terminal response without a second wake. After a completed wait times out, call send again with kind=request, wait=completed, and only invocationId/timeoutMs to continue waiting without resubmitting or writing mail.",
      "Message-platform sessions may use only list/get/send/inbox/read/ack. Their list/get/send targets are restricted to the current workspace, and sends require local targets.",
      "inbox/read/ack are current-session-only; inbox supports offset/limit pagination.",
    ],
    policy: sessionToolPolicy("external_write", ["plan", "execute", "fleet"]),
    resolvePolicy(args) {
      const action = typeof args.action === "string" ? args.action : "";
      return action === "list" || action === "get" || action === "inbox"
        ? sessionToolPolicy("read", ["plan", "execute", "fleet"])
        : sessionToolPolicy("external_write", ["plan", "execute"]);
    },
    parameters: Type.Object({
      action: Type.String({
        description:
          "list | get | create | call | bind | unbind | archive | restore | close | send | inbox | read | ack",
      }),
      sessionId: Type.Optional(
        Type.String({
          description:
            "Target for get/call/bind/unbind/archive/restore/close/inbox/read/ack, or requested id for create.",
        }),
      ),
      instruction: Type.Optional(
        Type.String({ description: "Instruction for an explicit Session call." }),
      ),
      reset: Type.Optional(
        Type.Boolean({ description: "Session call only; reset before submitting the turn." }),
      ),
      workspaceId: Type.Optional(
        Type.String({
          description: "Workspace override for create/list; defaults to the current workspace.",
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
      name: Type.Optional(Type.String({ description: "Independent display name for create." })),
      roleBinding: Type.Optional(
        Type.Any({
          description: "Create binding: {kind:'none'|'inherit'} or {kind:'explicit', roleRef}.",
        }),
      ),
      placement: Type.Optional(
        Type.String({ description: "Create placement: child (default) or sibling." }),
      ),
      supervisorSessionId: Type.Optional(
        Type.String({
          description: "Supervising Session for create; defaults to current Session.",
        }),
      ),
      cwd: Type.Optional(Type.String({ description: "Optional working directory for create." })),
      purpose: Type.Optional(
        Type.String({ description: "Optional bounded purpose for the created Session." }),
      ),
      cwdArtifactRef: Type.Optional(
        Type.String({ description: "Optional GitChange root for create cwd." }),
      ),
      externalKey: Type.Optional(Type.String()),
      toSessionId: Type.Optional(Type.String({ description: "Target session for send." })),
      kind: Type.Optional(
        Type.String({
          description:
            "request | notification. Defaults to notification; only request triggers target execution.",
        }),
      ),
      wait: Type.Optional(
        Type.String({
          description:
            "accepted | completed. Defaults to accepted; completed is valid only for request.",
        }),
      ),
      invocationId: Type.Optional(
        Type.String({
          description:
            "Accepted invocation to continue waiting for with action=send, kind=request, wait=completed; continuation skips mail and turn submission.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Completed request wait timeout in milliseconds (1000-300000).",
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
          typeof args.wait === "string" ? `wait=${args.wait}` : undefined,
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

function sessionToolPolicy(
  effect: "read" | "external_write",
  modes: readonly string[],
): NonNullable<ToolConfig["policy"]> {
  return {
    effect,
    executionMode: effect === "read" ? "parallel" : "sequential",
    domains: ["sessions"],
    modes,
    approval: effect === "read" ? "none" : "required",
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
    value === "create" ||
    value === "call" ||
    value === "bind" ||
    value === "unbind" ||
    value === "archive" ||
    value === "restore" ||
    value === "close" ||
    value === "send" ||
    value === "inbox" ||
    value === "read" ||
    value === "ack"
  )
    return value;
  throw new Error(
    "session.action must be list, get, create, call, bind, unbind, archive, restore, close, send, inbox, read, or ack",
  );
}

function stripAction(params: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, ...rest } = params;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}
