import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  SPARK_PROTOCOL_VERSION,
  sparkMessageViewSchema,
  sparkToolCallViewSchema,
  type SparkTurnSubmitResult,
} from "@zendev-lab/spark-protocol";

const projectionFixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/spark-protocol/src/fixtures/conversation-v2/projection.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { message: unknown; tool: unknown };

import type { Component, Focusable, TUI } from "../tui/pi-tui-adapter.ts";

import { SparkKeybindings } from "../host/keybindings.ts";
import { SparkHostRuntime } from "../host/runtime.ts";
import type { SparkHostMessageRenderer } from "../host/types.ts";
import { createSparkDaemonNativeCommands } from "../cli/daemon.ts";
import { maskNativeSecretRender } from "../native-tui/prompt.ts";
import {
  createSparkNativeUiTransport,
  SparkNativeSession,
  SparkNativeTuiApp,
  type SparkNativeAdmissionContext,
  type SparkNativeResponder,
  type SparkNativeResponderContext,
} from "../native-tui.ts";

const ESC = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "gu");
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function fakeTui(): TUI {
  return {
    requestRender: () => undefined,
    terminal: { rows: 30, cols: 100, columns: 100 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
  } as unknown as TUI;
}

function renderMessageContent(content: Parameters<SparkHostMessageRenderer>[0]["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

test("SparkHostRuntime registers and exposes custom message renderers", () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-rendering" });
  const renderer: SparkHostMessageRenderer = (message) => ({
    render: () => [`rendered:${message.customType}:${renderMessageContent(message.content)}`],
  });

  host.registerMessageRenderer("status-update", renderer);

  assert.equal(host.getMessageRenderer("status-update"), renderer);
  assert.deepEqual(
    host.listMessageRenderers().map((entry) => entry.customType),
    ["status-update"],
  );
  assert.throws(() => host.registerMessageRenderer("", renderer), /requires a customType/);
  assert.throws(
    () => host.registerMessageRenderer("bad", undefined as unknown as SparkHostMessageRenderer),
    /requires a renderer function/,
  );
});

test("SparkNativeSession appends streaming assistant chunks smoothly", () => {
  const session = new SparkNativeSession();
  session.appendAssistantChunk("hello");
  session.appendAssistantChunk(" world");
  session.finishAssistantMessage();

  const assistantMessages = session.messages.filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0]!.text, "hello world");
  assert.equal(assistantMessages[0]!.streaming, false);
});

test("SparkNativeSession responder context streams assistant chunks without duplicate final text", async () => {
  const session = new SparkNativeSession(async (_input, context) => {
    context.appendAssistantChunk?.("hello");
    context.appendAssistantChunk?.(" world");
    return "final duplicate should be ignored";
  });

  await session.submit("go");
  await waitUntil(() => !session.isProcessing);

  const assistantMessages = session.messages.filter((message) => message.role === "assistant");
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0]!.text, "hello world");
  assert.equal(assistantMessages[0]!.streaming, false);
});

test("SparkNativeSession merges a daemon user projection into its optimistic input", async () => {
  let releaseObservation: (() => void) | undefined;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => ({
        invocationId: "inv_user_dedup",
        status: "running" as const,
        acceptedAt: "2026-08-05T00:00:00.000Z",
      }),
      observe: async () =>
        await new Promise<string>((resolve) => {
          releaseObservation = () => resolve("");
        }),
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  await session.submit("render once", { submissionId: "idem_user_dedup" });
  await waitUntil(() =>
    session.messages.some(
      (message) => message.role === "user" && message.details?.invocationId === "inv_user_dedup",
    ),
  );
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "daemon-user-message",
    role: "user",
    text: "render once",
    status: "done",
    createdAt: "2026-08-05T00:00:00.000Z",
    metadata: { invocationId: "inv_user_dedup" },
  });

  assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
  assert.equal((stripAnsi(app.render(100).join("\n")).match(/> render once/gu) ?? []).length, 1);
  await waitUntil(() => releaseObservation !== undefined);
  releaseObservation?.();
  await waitUntil(() => !session.isProcessing);
});

test("SparkNativeSession deduplicates a daemon user projection that wins the admission race", async () => {
  let acceptAdmission: (() => void) | undefined;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async () => {
        await new Promise<void>((resolve) => {
          acceptAdmission = resolve;
        });
        return {
          invocationId: "inv_user_race",
          status: "running" as const,
          acceptedAt: "2026-08-05T00:00:00.000Z",
        };
      },
      observe: async () => "",
      cancel: async (invocationId: string) => ({
        invocationId,
        status: "cancelled" as const,
        cancelRequested: true,
      }),
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);

  await session.submit("race once", { submissionId: "idem_user_race" });
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "daemon-user-race",
    role: "user",
    text: "race once",
    status: "done",
    metadata: { invocationId: "inv_user_race" },
  });
  assert.equal(session.messages.filter((message) => message.role === "user").length, 2);
  acceptAdmission?.();
  await waitUntil(() => !session.isProcessing);
  assert.equal(session.messages.filter((message) => message.role === "user").length, 1);
});

test("native secret masking preserves only prompt, reverse-video CSI, and the Pi cursor marker", () => {
  const cursorMarker = "\x1b_pi:c\x07";
  const redCsi = "\x1b[31m";
  const cursorCsi = "\x1b[2C";
  const osc = "\x1b]0;secret-title\x07";
  const unknownApc = "\x1b_private-secret\x07";
  const unknownEscape = "\x1bX";
  const raw = `> \x1b[7m${"secret"[0]}\x1b[27m${cursorMarker}${redCsi}${cursorCsi}${osc}${unknownApc}${unknownEscape}${"secret".slice(1)}  `;
  const masked = maskNativeSecretRender(raw);

  assert.equal(masked, `> \x1b[7m•\x1b[27m${cursorMarker}•••••••  `);
  assert.match(masked, /^> /u);
  assert.equal(masked.includes(cursorMarker), true);
  assert.equal(masked.includes("\x1b[7m"), true);
  assert.equal(masked.includes("\x1b[27m"), true);
  assert.equal(masked.includes(redCsi), false);
  assert.equal(masked.includes(cursorCsi), false);
  assert.equal(masked.includes(osc), false);
  assert.equal(masked.includes(unknownApc), false);
  assert.equal(masked.includes(unknownEscape), false);
  assert.doesNotMatch(masked, /secret-title|private-secret|secret  /u);
});

test("SparkNativeTuiApp masks secret input and keeps it out of the transcript", async () => {
  let overlay: Component | undefined;
  const tui = {
    requestRender: () => undefined,
    terminal: { rows: 30, cols: 100, columns: 100 },
    addChild: () => undefined,
    removeChild: () => undefined,
    setFocus: () => undefined,
    showOverlay(component: Component) {
      overlay = component;
      if ("focused" in component) (component as Component & Focusable).focused = true;
      return { hide: () => (overlay = undefined) };
    },
  } as unknown as TUI;
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(tui, session, () => undefined);
  const secretMarker = "sk-live-secret-marker";
  const transcriptBefore = session.messages.map(({ role, text }) => ({ role, text }));

  const pending = app.secret("Enter API key");
  assert.ok(overlay);
  overlay.handleInput?.(secretMarker);
  const rawRendered = overlay.render(80).join("\n");
  assert.doesNotMatch(rawRendered, /sk-live-secret-marker/);
  assert.equal(rawRendered.includes("\x1b[7m"), true);
  assert.equal(rawRendered.includes("\x1b[27m"), true);
  assert.equal(rawRendered.includes("\x1b_pi:c\x07"), true);
  assert.match(rawRendered, /^.*> /mu);
  const rendered = stripAnsi(rawRendered);
  assert.doesNotMatch(rendered, /sk-live-secret-marker/);
  assert.match(rendered, /•{8,}/u);
  overlay.handleInput?.("\r");

  assert.equal(await pending, secretMarker);
  assert.deepEqual(
    session.messages.map(({ role, text }) => ({ role, text })),
    transcriptBefore,
  );
  assert.doesNotMatch(app.render(80).join("\n"), /sk-live-secret-marker/);
});

test("SparkNativeTuiApp folds tool output and toggles thinking/tool visibility", () => {
  const session = new SparkNativeSession();
  session.addToolMessage({ toolName: "impl_status", text: "long tool output", status: "success" });
  session.addThinking("hidden reasoning trace");
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  let rendered = stripAnsi(app.render(80).join("\n"));
  assert.match(rendered, /✓ tool:impl_status \[succeeded\] — long tool output • folded/);
  assert.match(rendered, /thinking • hidden/);
  assert.doesNotMatch(rendered, /hidden reasoning trace/);

  assert.equal(app.toggleTools(), true);
  assert.equal(app.toggleThinking(), true);
  rendered = stripAnsi(app.render(80).join("\n"));
  assert.match(rendered, /┌─ ✓ tool:impl_status \[succeeded\]/);
  assert.match(rendered, /│ long tool output/);
  assert.match(rendered, /└─ Ctrl\+O collapse/);
  assert.match(rendered, /thinking> hidden reasoning trace/);
});

test("SparkNativeSession merges pending and completed tool previews by toolCallId", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "tool-call:read-1",
    role: "tool",
    text: "calling read",
    status: "pending",
    toolCallId: "read-1",
    toolName: "read",
    createdAt: "2026-07-07T00:00:01.000Z",
    metadata: {},
  });
  assert.match(stripAnsi(app.render(80).join("\n")), /◌ tool:read \[pending\]/);
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "tool-result:read-1",
    role: "tool",
    text: "read ok",
    status: "done",
    toolCallId: "read-1",
    toolName: "read",
    createdAt: "2026-07-07T00:00:02.000Z",
    metadata: {},
  });

  const toolMessages = session.messages.filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0]?.text, "read ok");
  assert.equal(toolMessages[0]?.viewId, "tool-result:read-1");
  assert.match(stripAnsi(app.render(80).join("\n")), /✓ tool:read \[succeeded\] — read ok/);
});

test("SparkNativeSession updates assistant tool-call rows in place when results arrive", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "assistant:tool-batch",
    role: "assistant",
    text: "",
    status: "streaming",
    parts: [
      {
        id: "assistant:tool-batch:find",
        type: "tool-call",
        toolCallId: "find-1",
        toolName: "find",
        status: "pending",
        summary: "path=/workspace pattern=*",
        metadata: {},
      },
      {
        id: "assistant:tool-batch:grep",
        type: "tool-call",
        toolCallId: "grep-1",
        toolName: "grep",
        status: "pending",
        summary: "path=/workspace pattern=T",
        metadata: {},
      },
    ],
    metadata: {},
  });

  let rendered = stripAnsi(app.render(120).join("\n"));
  assert.equal(rendered.match(/tool:find/gu)?.length, 1);
  assert.equal(rendered.match(/tool:grep/gu)?.length, 1);
  assert.match(rendered, /tool:find \[pending\]/u);

  for (const [toolCallId, toolName, summary] of [
    ["find-1", "find", "found config.py"],
    ["grep-1", "grep", "sft_config.py:19"],
  ] as const) {
    session.addMessageView({
      version: SPARK_PROTOCOL_VERSION,
      id: `tool-call:${toolCallId}`,
      role: "tool",
      text: summary,
      status: "done",
      toolCallId,
      toolName,
      parts: [
        {
          id: `tool-call:${toolCallId}:part:0`,
          type: "tool-result",
          toolCallId,
          toolName,
          status: "complete",
          summary,
          metadata: {},
        },
      ],
      metadata: {},
    });
  }

  rendered = stripAnsi(app.render(120).join("\n"));
  assert.equal(rendered.match(/tool:find/gu)?.length, 1);
  assert.equal(rendered.match(/tool:grep/gu)?.length, 1);
  assert.doesNotMatch(rendered, /\[pending\]/u);
  assert.match(rendered, /✓ tool:find \[succeeded\] — found config\.py/u);
  assert.match(rendered, /✓ tool:grep \[succeeded\] — sft_config\.py:19/u);
  assert.equal(session.messages.filter((message) => message.role === "tool").length, 0);
});

test("SparkNativeSession coalesces out-of-order tool results without downgrading terminal state", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "tool-result:late-call",
    role: "tool",
    text: "permission denied",
    status: "error",
    toolCallId: "late-call",
    toolName: "write",
    parts: [
      {
        id: "tool-result:late-call:part:0",
        type: "tool-result",
        toolCallId: "late-call",
        toolName: "write",
        status: "failed",
        summary: "permission denied",
        metadata: {},
      },
    ],
    metadata: {},
  });
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "assistant:late-call",
    role: "assistant",
    text: "",
    status: "streaming",
    parts: [
      {
        id: "assistant:late-call:part:0",
        type: "tool-call",
        toolCallId: "late-call",
        toolName: "write",
        status: "pending",
        summary: "path=/workspace/config.ts",
        metadata: {},
      },
    ],
    metadata: {},
  });

  // A later assistant refresh can still carry stale pending state. It must not
  // recreate a second row or overwrite the already observed terminal result.
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "assistant:late-call",
    role: "assistant",
    text: "",
    status: "streaming",
    parts: [
      {
        id: "assistant:late-call:part:0",
        type: "tool-call",
        toolCallId: "late-call",
        toolName: "write",
        status: "pending",
        summary: "path=/workspace/config.ts",
        metadata: {},
      },
    ],
    metadata: {},
  });

  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.equal(rendered.match(/tool:write/gu)?.length, 1);
  assert.match(rendered, /✗ tool:write \[failed\] — permission denied/u);
  assert.doesNotMatch(rendered, /\[pending\]/u);
  assert.equal(session.messages.filter((message) => message.role === "tool").length, 0);
});

test("SparkNativeTuiApp renders session, model, thinking, run, and queue state clearly", async () => {
  const session = new SparkNativeSession(async () => await new Promise<string>(() => undefined));
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    statusContext: {
      activeModel: () => "openai-codex/gpt-5.4",
      thinkingLevel: () => "high",
    },
  });
  app.hydrateHub({
    sessionId: "sess-native-status",
    sessionTitle: "Fix renderer",
    sessionStatus: "idle",
  });

  assert.equal(await session.submit("start"), "started");
  assert.equal(await session.submit("steer now", { mode: "steer" }), "queued");
  assert.equal(await session.submit("then summarize", { mode: "followUp" }), "queued");

  const rendered = stripAnsi(app.render(140).join("\n"));
  assert.match(
    rendered,
    /session Fix renderer • model openai-codex\/gpt-5\.4 • thinking high • state running • queue steer=1 follow-up=1/,
  );
  assert.match(
    rendered,
    /Enter steer • Alt\+Enter follow-up • Esc cancel active • Alt\+Up restore queue/,
  );
  assert.match(rendered, /◆ Input queue · local 2/);
  assert.match(rendered, /├─ 1\. steer · steer now/);
  assert.match(rendered, /└─ 2\. follow-up · then summarize/);
  assert.match(rendered, /Alt\+Up restore all/);
  assert.doesNotMatch(rendered, /you (?:steer|follow-up) queued>/);
  assert.doesNotMatch(rendered, /Queued (?:steering message|follow-up)/);

  const queueSnapshot = session.queuedInputs;
  assert.deepEqual(queueSnapshot, [
    { text: "steer now", mode: "steer" },
    { text: "then summarize", mode: "followUp" },
  ]);
  assert.equal(Object.isFrozen(queueSnapshot), true);
  assert.equal(
    queueSnapshot.every((input) => Object.isFrozen(input)),
    true,
  );

  session.abort("test cleanup");
});

test("SparkNativeTuiApp labels daemon-owned admission and queue state explicitly", async () => {
  let nextInvocation = 0;
  let cancelCalls = 0;
  const responder = Object.assign(
    async (_input: string, _context: SparkNativeResponderContext) => "compatibility path",
    {
      admit: async (_input: string, _context: SparkNativeAdmissionContext) => {
        nextInvocation += 1;
        return {
          invocationId: `inv_${nextInvocation}`,
          status: "queued" as const,
          acceptedAt: `2026-07-28T00:00:0${nextInvocation}.000Z`,
        };
      },
      observe: async (_admission: SparkTurnSubmitResult, context: SparkNativeResponderContext) =>
        await new Promise<string>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => reject(context.signal?.reason ?? new Error("detached")),
            { once: true },
          );
        }),
      cancel: async (invocationId: string) => {
        cancelCalls += 1;
        return {
          invocationId,
          status: "cancelled" as const,
          cancelRequested: true,
        };
      },
    },
  ) satisfies SparkNativeResponder;
  const session = new SparkNativeSession(responder);
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  await session.submit("first", { submissionId: "idem_render_first" });
  await new Promise((resolve) => setImmediate(resolve));
  const singleTurnRendered = stripAnsi(app.render(120).join("\n"));
  assert.doesNotMatch(singleTurnRendered, /Daemon turn queue/u);
  assert.doesNotMatch(singleTurnRendered, /daemon queued · first/u);

  await session.submit("second", {
    mode: "followUp",
    submissionId: "idem_render_second",
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.match(rendered, /queue steer=0 follow-up=0 daemon=1/u);
  assert.match(rendered, /◆ Daemon turn queue · admitting 0 · waiting 1/u);
  assert.doesNotMatch(rendered, /daemon queued · first/u);
  assert.match(rendered, /daemon queued · second/u);
  assert.match(rendered, /daemon owns execution · Esc cancels the active invocation/u);
  assert.match(rendered, /Enter queue next • Esc cancel active • Alt\+Up restore queue/u);
  assert.doesNotMatch(rendered, /Enter steer/u);
  assert.equal(session.canRestoreQueuedInput, true);
  assert.equal(session.restoreQueuedText(), "second");
  assert.deepEqual(
    session.daemonQueued.map((turn) => turn.prompt),
    ["second"],
  );

  app.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelCalls, 0);
});

test("SparkNativeTuiApp bounds queue rows and sanitizes inline image previews", async () => {
  const session = new SparkNativeSession(async () => await new Promise<string>(() => undefined));
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  assert.equal(await session.submit("start"), "started");
  assert.equal(
    await session.submit(
      '<image name="preview.png">data:image/png;base64,SECRET_IMAGE_BYTES</image> inspect',
      { mode: "steer" },
    ),
    "queued",
  );
  for (const prompt of ["second", "third", "fourth", "fifth"]) {
    assert.equal(await session.submit(prompt, { mode: "followUp" }), "queued");
  }

  const rendered = stripAnsi(app.render(100).join("\n"));
  assert.match(rendered, /◆ Input queue · local 5/);
  assert.match(
    rendered,
    /1\. steer · <image name="preview\.png">\[inline image data omitted\]<\/image> inspect/,
  );
  assert.match(rendered, /4\. follow-up · fourth/);
  assert.match(rendered, /└─ … \+1 more/);
  assert.doesNotMatch(rendered, /SECRET_IMAGE_BYTES|5\. follow-up · fifth/);

  session.abort("test cleanup");
});

test("SparkNativeTuiApp uses custom message renderers and skips display=false custom messages", () => {
  const session = new SparkNativeSession();
  session.addCustomMessage({
    customType: "status-update",
    content: "green",
    details: { level: "success" },
  });
  session.addCustomMessage({ customType: "status-update", content: "hidden", display: false });
  const renderers = new Map<string, SparkHostMessageRenderer>([
    [
      "status-update",
      (message, options) => ({
        render: () => [
          `custom-render:${renderMessageContent(message.content)}:expanded=${String(options.expanded)}`,
        ],
      }),
    ],
  ]);
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    messageRenderers: renderers,
  });

  const rendered = app.render(80).join("\n");
  assert.match(rendered, /custom-render:green:expanded=true/);
  assert.doesNotMatch(rendered, /hidden/);
});

test("SparkNativeTuiApp renders native setStatus and setWidget surfaces", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setStatus("spark-role-runs", "roles: running=1 waiting=1");
  app.setWidget("spark-role-runs", ["◆ Role runs (running=1)", "├─ ▶ worker @role-tui · 2s"], {
    placement: "belowEditor",
  });

  let rendered = app.render(100).join("\n");
  assert.match(rendered, /session local • state idle • roles: running=1 waiting=1/);
  assert.match(rendered, /◆ Role runs \(running=1\)/);
  assert.match(rendered, /worker @role-tui/);

  app.setStatus("spark-role-runs", undefined);
  app.setWidget("spark-role-runs", undefined, { placement: "belowEditor" });
  rendered = app.render(100).join("\n");
  assert.doesNotMatch(rendered, /roles: running=1/);
  assert.doesNotMatch(rendered, /◆ Role runs/);
});

test("SparkNativeTuiApp replaces a widget with the same key instead of stacking it", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setWidget("spark-status", ["◆ Repro(old)"], { placement: "belowEditor" });
  app.setWidget("spark-status", ["◆ Repro(new)"], { placement: "belowEditor" });

  const rendered = app.render(100).join("\n");
  assert.doesNotMatch(rendered, /Repro\(old\)/u);
  assert.equal(rendered.match(/Repro\(new\)/gu)?.length, 1);
});

test("Spark native UI transport bridges notify, status, widget, and custom", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  assert.deepEqual(ui.interactionCapabilities, {
    version: 1,
    askFlow: {
      deliveries: ["blocking"],
      timeout: true,
      responseCorrelation: "request_id",
    },
  });

  ui.notify?.("hello", "success");
  ui.setStatus?.("spark-role-runs", "roles: failed=1");
  ui.setWidget?.("spark-role-runs", "role board\nsecond line", { placement: "aboveEditor" });
  const customResult = await (ui.custom?.(
    (_tui: unknown, _theme: unknown, _keybindings: unknown, done: (value: string) => void) => {
      done("custom-result");
      return { render: () => [], invalidate() {} } satisfies Component;
    },
    { overlay: false },
  ) as Promise<string>);

  assert.equal(customResult, "custom-result");
  const rendered = app.render(100).join("\n");
  assert.match(rendered, /custom:notification> success: hello/);
  assert.match(rendered, /roles: failed=1/);
  assert.match(rendered, /role board/);
  assert.match(rendered, /second line/);
});

test("SparkNativeTuiApp records protocol hub state and renders Spark panels", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.applyViewModelEvent({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "native-hub-session",
      status: "idle",
      messages: [],
      tools: [],
      runs: [
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "role-run-reviewer",
          kind: "role",
          title: "reviewer audit",
          status: "running",
          progress: 0.5,
          evidenceRefs: ["evidence:review-verdict"],
          artifactRefs: [],
          metadata: { reviewer: "reviewer", outcome: "pending" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          id: "workflow-run-release",
          kind: "workflow",
          title: "release readiness workflow",
          status: "queued",
          evidenceRefs: [],
          artifactRefs: [],
          metadata: { selector: "builtin:release-readiness" },
        },
      ],
      tasks: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "task:hub",
          title: "Build hub",
          status: "running",
          todos: [
            { id: "todo-1", content: "wire task board", status: "done", notes: [] },
            { id: "todo-2", content: "wire evidence panel", status: "in_progress", notes: [] },
          ],
          runRefs: ["role-run-reviewer"],
          evidenceRefs: ["evidence:evidence"],
          artifactRefs: [],
          metadata: {},
        },
      ],
      artifacts: [
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "evidence:review-verdict",
          title: "Reviewer verdict",
          kind: "record",
          format: "json",
          status: "approved",
          producer: "review",
          preview: "approved with evidence",
          metadata: { outcome: "approved" },
        },
        {
          version: SPARK_PROTOCOL_VERSION,
          ref: "evidence:graft-patch",
          title: "Graft patch status",
          kind: "record",
          format: "json",
          status: "candidate",
          producer: "task",
          preview: "patch:abc123",
          metadata: {
            patchRef: "patch:abc123",
            candidateRef: "candidate:def456",
            base: "HEAD",
            graftStatus: "validated",
          },
        },
      ],
      evidence: [],
      metadata: {},
    },
  });

  await app.handleInteractionRequest({
    version: SPARK_PROTOCOL_VERSION,
    kind: "workflowPicker",
    requestId: "workflow-picker-1",
    title: "Pick a workflow",
    prompt: "Choose a saved workflow",
    options: [
      {
        selector: "builtin:release-readiness",
        label: "Release readiness",
        description: "Run release preflight",
        metadata: {},
      },
    ],
    metadata: {},
  });

  assert.deepEqual(app.hubSnapshot(), {
    activePanel: undefined,
    sessionId: "native-hub-session",
    sessionStatus: "idle",
    reproProjectionStatus: "unavailable",
    selectedReproLane: "implementation",
    reproDetailExpanded: false,
    workflows: 1,
    workflowRuns: 1,
    roleRuns: 1,
    tasks: 1,
    artifacts: 0,
    evidence: 2,
    reviews: 2,
    graftItems: 1,
    interactions: 1,
  });

  assert.equal(await app.submitInput("/inspect"), "command");
  assert.equal(app.hubSnapshot().activePanel, "overview");
  let rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: overview/);
  assert.match(rendered, /Cross-session Hub: run spark hub in another terminal/);
  assert.match(rendered, /Workflow picker\/progress: 1 option\(s\), 1 workflow run\(s\)/);
  assert.match(rendered, /Role-run board: 1 role run\(s\), 1 interaction\(s\)/);
  assert.match(rendered, /Graft provenance\/patch status: 1 item\(s\)/);

  assert.equal(await app.submitInput("/inspect workflows"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: workflows/);
  assert.match(rendered, /picker workflow-picker-1: Pick a workflow/);
  assert.match(rendered, /builtin:release-readiness: Release readiness/);

  assert.equal(await app.submitInput("/inspect runs"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: role\/run board/);
  assert.match(rendered, /role role-run-reviewer \[running\] 50% evidence=1 reviewer audit/);

  assert.equal(await app.submitInput("/tasks"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: task\/project board/);
  assert.match(rendered, /task:hub \[running\] todos=1\/2 evidence=1 Build hub/);

  assert.equal(await app.submitInput("/artifacts"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: artifacts/);
  assert.match(
    rendered,
    /evidence:review-verdict \[record\/json\] producer=review status=approved/,
  );
  assert.match(rendered, /evidence:graft-patch \[record\/json\] producer=task status=candidate/);

  assert.equal(await app.submitInput("/reviews"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: reviewer verdicts/);
  assert.match(rendered, /evidence:review-verdict \[approved\] Reviewer verdict/);

  assert.equal(await app.submitInput("/graft"), "command");
  rendered = app.render(120).join("\n");
  assert.match(rendered, /Session inspector: Graft provenance\/patch status/);
  assert.match(
    rendered,
    /patch=patch:abc123 candidate=candidate:def456 base=HEAD status=validated/,
  );
});

test("SparkHostRuntime custom messages reach native registered message renderers", () => {
  const runtime = new SparkHostRuntime({ cwd: "/tmp/spark-rendering", hasUI: true });
  runtime.registerMessageRenderer("spark-role-run-completion", (message) => ({
    render: () => [
      `completion-rendered:${message.customType}:${renderMessageContent(message.content)}`,
    ],
  }));
  const session = new SparkNativeSession();
  const renderers = new Map(
    runtime.listMessageRenderers().map(({ customType, renderer }) => [customType, renderer]),
  );
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    messageRenderers: renderers,
  });
  runtime.setUiTransport(createSparkNativeUiTransport(app, session));

  runtime.sendMessage(
    {
      customType: "spark-role-run-completion",
      content: "researcher completed: run:abc",
      display: true,
      details: { status: "done" },
    },
    { deliverAs: "followUp" },
  );

  assert.equal(runtime.peekOutbox().length, 1, "agent-loop outbox behavior is preserved");
  assert.match(
    app.render(100).join("\n"),
    /completion-rendered:spark-role-run-completion:researcher completed: run:abc/,
  );
});

test("SparkNativeTuiApp renders component widget factories natively", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setWidget(
    "spark-status",
    (
      tui: { terminal: { columns: number } },
      theme: { fg(color: string, text: string): string },
    ) => ({
      render: () => [theme.fg("accent", `◆ Spark status width=${tui.terminal.columns}`)],
      invalidate: () => undefined,
    }),
    { placement: "belowEditor" },
  );

  const rendered = app.render(100).join("\n");
  assert.match(rendered, /◆ Spark status width=100/);
  assert.doesNotMatch(rendered, /component factory is not supported/);
});

test("SparkNativeTuiApp provides strikethrough fallback to component widgets", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  app.setWidget(
    "spark-status",
    (_tui: { terminal: { columns: number } }, theme: { strikethrough(text: string): string }) => ({
      render: () => [`done=${theme.strikethrough("task")}`],
    }),
    { placement: "aboveEditor" },
  );

  const rendered = app.render(100).join("\n");
  assert.match(rendered, /done=.*task/);
  assert.doesNotMatch(rendered, /widget render failed/);
});

test("SparkNativeTuiApp dispatches app keybindings before editor input", async () => {
  const session = new SparkNativeSession();
  const keybindings = new SparkKeybindings();
  let picked = 0;
  keybindings.register({
    id: "app.modelPicker",
    defaultKey: "ctrl+l",
    description: "Open model picker",
    handler: () => void (picked += 1),
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, { keybindings });

  app.handleInput("\f");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(picked, 1);
});

test("SparkNativeTuiApp contains async keybinding failures and stays interactive", async () => {
  const session = new SparkNativeSession();
  const keybindings = new SparkKeybindings();
  let attempts = 0;
  keybindings.register({
    id: "app.thinking.cycle",
    defaultKey: "shift+tab",
    description: "Cycle thinking level",
    handler: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Spark daemon is not reachable: connect ENOENT daemon.sock");
      }
    },
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, { keybindings });

  app.handleInput("\x1b[Z");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attempts, 1);
  assert.match(
    stripAnsi(app.render(100).join("\n")),
    /Shortcut action failed: Spark daemon is not reachable: connect ENOENT daemon\.sock/u,
  );

  app.handleInput("\x1b[Z");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
});

test("SparkNativeTuiApp installs Ctrl+O/Ctrl+T and hub keybindings", async () => {
  const session = new SparkNativeSession();
  const keybindings = new SparkKeybindings();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, { keybindings });

  assert.equal(app.areToolsExpanded(), false);
  assert.equal(app.isThinkingExpanded(), false);
  assert.equal(app.hubSnapshot().activePanel, undefined);
  assert.equal(await keybindings.executeKey("ctrl+o", {}), true);
  assert.equal(await keybindings.executeKey("ctrl+t", {}), true);
  assert.equal(await keybindings.executeKey("ctrl+k", {}), true);
  assert.equal(app.areToolsExpanded(), true);
  assert.equal(app.isThinkingExpanded(), true);
  assert.equal(app.hubSnapshot().activePanel, "overview");
  assert.equal(await keybindings.executeKey("shift+ctrl+k", {}), true);
  assert.equal(app.hubSnapshot().activePanel, "workflows");
});

test("SparkNativeTuiApp handles local slash commands without submitting to responder", async () => {
  let responderCalls = 0;
  const session = new SparkNativeSession(() => {
    responderCalls += 1;
    return "unexpected";
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    slashCommands: {
      status: {
        description: "show daemon status",
        handler: () => "daemon: running",
      },
    },
  });

  assert.equal(await app.submitInput("/help commands"), "command");
  assert.equal(await app.submitInput("/status inspect"), "command");

  const rendered = app.render(100).join("\n");
  assert.equal(responderCalls, 0);
  assert.match(rendered, /Spark commands/);
  assert.match(rendered, /Common/);
  assert.match(rendered, /\/status — show daemon status/);
  assert.match(rendered, /Advanced/);
  assert.match(rendered, /\/reload — restart the TUI process and keep this session/);
  assert.doesNotMatch(rendered, /\/plan —/);
  assert.doesNotMatch(rendered, /\/goal —/);
  assert.doesNotMatch(rendered, /\/hub —/);
  assert.match(
    rendered,
    /\/inspect \[overview\|repro\|workflows\|runs\|tasks\|artifacts\|reviews\|graft\|off\]/,
  );
  assert.match(rendered, /daemon: running/);
});

test("SparkNativeTuiApp /clear keeps the welcome banner and removes old transcript", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  session.addToolMessage({ toolName: "read", text: "old output" });
  assert.match(app.render(100).join("\n"), /tool:read/);

  assert.equal(await app.submitInput("/clear"), "command");
  const rendered = app.render(100).join("\n");
  assert.doesNotMatch(rendered, /tool:read/);
  assert.doesNotMatch(rendered, /old output/);
  assert.match(rendered, /Transcript cleared/);
  assert.match(rendered, /Type a task, \/plan for durable work/);
});

test("SparkNativeTuiApp /stop aborts the active turn and discards late responses", async () => {
  let resolveResponse: ((value: string) => void) | undefined;
  let sawAbort = false;
  const session = new SparkNativeSession((_input, context) => {
    context.signal?.addEventListener("abort", () => {
      sawAbort = true;
    });
    return new Promise<string>((resolve) => {
      resolveResponse = resolve;
    });
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  assert.equal(await app.submitInput("long turn"), "started");
  assert.equal(session.isProcessing, true);
  assert.equal(await app.submitInput("queued follow-up"), "queued");
  assert.equal(session.queuedCount, 1);

  assert.equal(await app.submitInput("/stop dogfood test"), "command");
  assert.equal(session.isProcessing, false);
  assert.equal(session.queuedCount, 0);
  assert.equal(sawAbort, true);

  resolveResponse?.("late assistant response");
  await new Promise((resolve) => setImmediate(resolve));

  const rendered = app.render(100).join("\n");
  assert.match(rendered, /Stopped current Spark turn \(dogfood test\)/);
  assert.doesNotMatch(rendered, /late assistant response/);
});

test("SparkNativeSession maps transcript to and from Spark session view models", () => {
  const session = new SparkNativeSession();
  session.addToolMessage({ toolName: "read", text: "ok", status: "success" });
  session.appendAssistantChunk("streaming");

  const view = session.toSessionView("session-view");
  assert.equal(view.version, SPARK_PROTOCOL_VERSION);
  assert.equal(view.sessionId, "session-view");
  assert.equal(view.messages.at(-1)?.status, "streaming");
  assert.equal(
    view.messages.some((message) => message.role === "tool" && message.toolName === "read"),
    true,
  );

  const restored = new SparkNativeSession();
  restored.applySessionView({
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "restored",
    status: "idle",
    messages: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "m1",
        role: "assistant",
        text: "from view",
        status: "done",
        metadata: {},
      },
    ],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    metadata: {},
  });

  assert.equal(restored.messages.length, 1);
  assert.equal(restored.messages[0]?.role, "assistant");
  assert.equal(restored.messages[0]?.text, "from view");
});

test("SparkNativeSession projects structured tool states without exposing raw input", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  session.applySessionView({
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "tool-states",
    status: "running",
    messages: [],
    tools: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "tool-running",
        name: "shell",
        status: "running",
        input: { command: "secret --token hidden" },
        output: "raw output must stay hidden",
        metadata: { displaySummary: "Executing shell" },
      },
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "tool-cancelled",
        name: "edit",
        status: "cancelled",
        metadata: {},
      },
    ],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    metadata: {},
  });

  const rendered = stripAnsi(app.render(100).join("\n"));
  assert.match(rendered, /▶ tool:shell \[running\]/);
  assert.match(rendered, /Executing shell/);
  assert.match(rendered, /■ tool:edit \[cancelled\]/);
  assert.doesNotMatch(rendered, /secret --token hidden/);
  assert.doesNotMatch(rendered, /raw output must stay hidden/);
});

test("SparkNativeSession renders one shared conversation projection and merges tool lineage", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  session.applySessionView({
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "part-projection",
    status: "streaming",
    messages: [sparkMessageViewSchema.parse(projectionFixture.message)],
    tools: [sparkToolCallViewSchema.parse(projectionFixture.tool)],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    metadata: {},
  });

  const rendered = stripAnsi(app.render(100).join("\n"));
  assert.match(rendered, /Ready\./);
  assert.match(rendered, /Done\./);
  assert.match(rendered, /thinking \[streaming\] • hidden/);
  assert.match(rendered, /✓ tool:read \[succeeded\] — README loaded/);
  assert.ok(rendered.indexOf("thinking [streaming]") < rendered.indexOf("Ready."));
  assert.ok(rendered.indexOf("Ready.") < rendered.indexOf("tool:read"));
  assert.ok(rendered.indexOf("tool:read") < rendered.indexOf("Done."));
  assert.equal(session.messages.length, 1);
  assert.equal(
    session.messages[0]?.conversation?.parts.filter((part) => part.type === "tool").length,
    1,
  );
  assert.doesNotMatch(rendered, /Legacy text must not duplicate/);
  assert.doesNotMatch(rendered, /raw README output|"token":"hidden"/);
});

test("SparkNativeTuiApp keeps streaming thinking state visible while folded", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "thinking-stream",
    role: "thinking",
    text: "private reasoning",
    status: "streaming",
    metadata: {},
  });

  let rendered = stripAnsi(app.render(80).join("\n"));
  assert.match(rendered, /thinking \[streaming\] • hidden/);
  assert.doesNotMatch(rendered, /private reasoning/);

  app.toggleThinking();
  rendered = stripAnsi(app.render(80).join("\n"));
  assert.match(rendered, /thinking> private reasoning ▋/);
});

test("SparkNativeSession orders view messages chronologically", () => {
  const session = new SparkNativeSession();
  session.applySessionView({
    version: SPARK_PROTOCOL_VERSION,
    sessionId: "ordered",
    status: "idle",
    messages: [
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "later",
        role: "assistant",
        text: "second",
        status: "done",
        createdAt: "2026-07-07T00:00:02.000Z",
        metadata: {},
      },
      {
        version: SPARK_PROTOCOL_VERSION,
        id: "earlier",
        role: "tool",
        text: "first",
        status: "done",
        createdAt: "2026-07-07T00:00:01.000Z",
        metadata: {},
      },
    ],
    tools: [],
    runs: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    metadata: {},
  });

  assert.deepEqual(
    session.messages.map((message) => message.text),
    ["first", "second"],
  );

  session.addMessageView({
    version: SPARK_PROTOCOL_VERSION,
    id: "later",
    role: "assistant",
    text: "second updated",
    status: "done",
    createdAt: "2026-07-07T00:00:02.000Z",
    metadata: {},
  });

  assert.deepEqual(
    session.messages.map((message) => message.text),
    ["first", "second updated"],
  );
});

test("SparkHostRuntime and native UI transport round-trip interaction protocol", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    interactionHandler: (request) => {
      if (request.kind === "askFlow") {
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "askFlow",
          requestId: request.requestId,
          status: "answered",
          answers: { plan: { values: ["a"] } },
          nextAction: "resume",
          metadata: {},
        };
      }
      if (request.kind === "modelSelect") {
        return {
          version: SPARK_PROTOCOL_VERSION,
          kind: "modelSelect",
          requestId: request.requestId,
          status: "answered",
          selection: { providerName: "baidu-oneapi", modelId: "claude-opus-4.8" },
          metadata: {},
        };
      }
      return {
        version: SPARK_PROTOCOL_VERSION,
        kind: request.kind,
        requestId: request.requestId,
        status: "answered",
        approved: true,
        metadata: {},
      };
    },
  });
  const runtime = new SparkHostRuntime({ cwd: "/tmp/spark-interaction", hasUI: true });
  runtime.setUiTransport(createSparkNativeUiTransport(app, session));

  const ask = await runtime.requestInteraction({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-ask",
    kind: "askFlow",
    title: "Choose plan",
    mode: "decision",
    questions: [
      {
        id: "plan",
        prompt: "Which plan?",
        type: "single",
        required: true,
        defaultValues: [],
        options: [{ value: "a", label: "Plan A" }],
      },
    ],
    metadata: {},
  });
  const model = await runtime.requestInteraction({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-model",
    kind: "modelSelect",
    title: "Select model",
    options: [
      {
        value: "baidu-oneapi/claude-opus-4.8",
        providerName: "baidu-oneapi",
        modelId: "claude-opus-4.8",
        active: true,
        metadata: {},
      },
    ],
    metadata: {},
  });
  const approval = await runtime.requestInteraction({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-tool",
    kind: "toolApproval",
    title: "Run edit?",
    toolName: "edit",
    approveLabel: "Approve",
    rejectLabel: "Reject",
    metadata: {},
  });

  assert.equal(ask.kind, "askFlow");
  assert.equal(ask.status, "answered");
  assert.equal(model.kind, "modelSelect");
  assert.equal(model.status, "answered");
  assert.equal(approval.kind, "toolApproval");
  assert.equal(approval.status, "answered");
  assert.equal("approved" in approval ? approval.approved : false, true);
});

test("native UI transport consumes view model events without concrete TUI protocol types", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.snapshot",
    session: {
      version: SPARK_PROTOCOL_VERSION,
      sessionId: "native-session",
      cwd: "/workspace/spark",
      gitBranch: "main",
      status: "running",
      model: { providerName: "baidu-oneapi", modelId: "gpt-5.6-sol" },
      thinkingLevel: "xhigh",
      messages: [],
      tools: [],
      runs: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      metadata: {},
    },
  });
  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "session.message",
    sessionId: "native-session",
    message: {
      version: SPARK_PROTOCOL_VERSION,
      id: "message-1",
      role: "assistant",
      text: "hello from event",
      status: "done",
      metadata: {},
    },
  });
  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "run.update",
    run: {
      version: SPARK_PROTOCOL_VERSION,
      id: "run:1",
      kind: "daemon",
      status: "running",
      summary: "cache read=64 write=16",
      evidenceRefs: [],
      artifactRefs: [],
      metadata: {
        usageTotals: {
          inputTokens: 19_000_000,
          outputTokens: 820_000,
          cacheReadTokens: 230_000_000,
          cacheWriteTokens: 16,
          costUsd: 23.509,
          latestCacheHitPercent: 99.3,
          contextTokens: 262_632,
          contextWindow: 372_000,
        },
      },
    },
  });

  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.match(rendered, /hello from event/);
  assert.doesNotMatch(rendered, /custom:run-view>/);
  assert.match(rendered, /session native-session .*daemon running: cache read=64 write=16/);
  assert.match(rendered, /session native-session .*cache read=64 write=16/);
  assert.match(rendered, /\/workspace\/spark \(main\)/);
  assert.match(
    rendered,
    /↑19M ↓820k R230M W16 CH99\.3% \$23\.509 70\.6%\/372k \(auto\)\s+\(baidu-oneapi\) gpt-5\.6-sol • xhigh/,
  );

  const narrow = stripAnsi(app.render(60).join("\n"));
  assert.equal(
    narrow.split("\n").every((line) => Array.from(line).length <= 60),
    true,
  );
  assert.match(narrow, /gpt-5\.6-sol • xhigh/);
  assert.doesNotMatch(narrow, /\(baidu-oneapi\)/);
});

test("native UI transport projects task.update without a task-view transcript message", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "task.update",
    task: {
      version: SPARK_PROTOCOL_VERSION,
      ref: "task:bottom-status",
      title: "Keep task status at the bottom",
      status: "running",
      todos: [{ id: "todo-1", content: "render the projection", status: "in_progress", notes: [] }],
      runRefs: [],
      evidenceRefs: [],
      artifactRefs: [],
      metadata: {},
    },
  });

  assert.equal(app.hubSnapshot().tasks, 1);
  app.setEditorText("draft task prompt");
  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.match(
    rendered,
    /task:bottom-status \[running\] Keep task status at the bottom · todos 0\/1/,
  );
  assert.doesNotMatch(rendered, /custom:task-view>/);
  assert.ok(
    rendered.indexOf("task:bottom-status [running]") > rendered.indexOf("draft task prompt"),
    "task status must be rendered below the composer",
  );
});

test("native UI transport prints task completion evidence summaries", () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "evidence.update",
    evidence: {
      version: SPARK_PROTOCOL_VERSION,
      ref: "evidence:review",
      title: "Review verdict",
      kind: "record",
      format: "json",
      status: "passed",
      producer: "review",
      metadata: { outcome: "passed" },
    },
  });
  ui.publishView?.({
    version: SPARK_PROTOCOL_VERSION,
    type: "task.update",
    task: {
      version: SPARK_PROTOCOL_VERSION,
      ref: "task:visible",
      title: "Visible evidence task",
      status: "done",
      todos: [],
      runRefs: [],
      evidenceRefs: ["evidence:review", "evidence:trace"],
      artifactRefs: [],
      metadata: {},
    },
  });

  const rendered = stripAnsi(app.render(120).join("\n"));
  assert.match(
    rendered,
    /✔ task done · 2 evidence · review passed · inspect locally with \/inspect tasks \(task:visible\)/,
  );
});

test("native UI transport returns blocked protocol responses without handler", async () => {
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);
  const ui = createSparkNativeUiTransport(app, session);

  const response = await ui.interaction?.({
    version: SPARK_PROTOCOL_VERSION,
    requestId: "req-tool",
    kind: "toolApproval",
    title: "Run edit?",
    toolName: "edit",
    approveLabel: "Approve",
    rejectLabel: "Reject",
    metadata: {},
  });

  assert.equal(response?.status, "blocked");
  assert.equal(response?.kind, "toolApproval");
  assert.equal(response && "approved" in response ? response.approved : undefined, false);
  assert.match(
    stripAnsi(app.render(100).join("\n")),
    /custom:interaction-request> toolApproval: Run edit\?/,
  );
});

test("SparkNativeTuiApp /retry resubmits the previous user prompt", async () => {
  const prompts: string[] = [];
  const session = new SparkNativeSession((input) => {
    prompts.push(input);
    return `ack:${input}`;
  });
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined);

  assert.equal(await app.submitInput("first prompt"), "started");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await app.submitInput("/retry"), "command");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(prompts, ["first prompt", "first prompt"]);
  assert.match(app.render(100).join("\n"), /Retrying: first prompt/);
});

test("Spark daemon native slash commands render invocation status and start summaries", async () => {
  let started = false;
  const session = new SparkNativeSession();
  const app = new SparkNativeTuiApp(fakeTui(), session, () => undefined, {
    slashCommands: createSparkDaemonNativeCommands({
      startService: () => {
        started = true;
      },
      daemonStatus: async () => ({
        observedAt: "2026-06-22T00:00:00.000Z",
        servers: [{ url: "ws://local", workspaceCount: 2, wsConnected: true }],
        invocations: { queued: 1, running: 2, succeeded: 3, failed: 4, cancelled: 5 },
        channelDeliveries: {
          pending: 6,
          retrying: 2,
          inFlight: 1,
          delivered: 7,
          uncertain: 3,
        },
      }),
    }),
  });

  assert.equal(await app.submitInput("/start"), "command");
  assert.equal(await app.submitInput("/status inspect"), "command");

  const rendered = app.render(100).join("\n");
  assert.equal(started, true);
  assert.match(rendered, /daemon: running/);
  assert.match(rendered, /invocations: queued=1 running=2 succeeded=3 failed=4 cancelled=5/);
  assert.match(
    rendered,
    /channel-deliveries: pending=6 retrying=2 in-flight=1 delivered=7 uncertain=3/,
  );
  assert.match(rendered, /server: ws:\/\/local workspaces=2 ws=connected/);
  assert.doesNotMatch(rendered, /queue:/u);
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
