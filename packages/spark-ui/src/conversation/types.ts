import type { Snippet } from "svelte";

export type ConversationChainStep =
  | {
      type: "reasoning";
      summary: string;
      state: "streaming" | "complete";
      redacted?: boolean;
    }
  | {
      /** Provider-authored tool preamble/progress, distinct from private reasoning. */
      type: "commentary";
      summary: string;
      state: "streaming" | "complete";
    }
  | {
      type: "tool";
      callId: string;
      name: string;
      state: ConversationToolState;
      summary?: string;
    };

export type ConversationPart =
  | {
      type: "text";
      text: string;
      streaming: boolean;
    }
  | {
      type: "image";
      contentIndex: number;
      mediaType: "image/bmp" | "image/gif" | "image/jpeg" | "image/png" | "image/webp";
      name?: string;
    }
  | {
      type: "reasoning";
      summary: string;
      state: "streaming" | "complete";
      redacted?: boolean;
    }
  | {
      type: "commentary";
      summary: string;
      state: "streaming" | "complete";
    }
  | {
      type: "tool";
      callId: string;
      name: string;
      state: ConversationToolState;
      summary?: string;
    }
  | {
      /** Collapsible execution chain: reasoning, commentary, and tool process together. */
      type: "chain";
      state: "streaming" | "complete";
      steps: ConversationChainStep[];
    }
  | {
      type: "task";
      taskRef: string;
      title: string;
      state: ConversationTaskState;
      summary?: string;
    }
  | {
      type: "approval";
      requestId: string;
      title: string;
      state: ConversationApprovalState;
      kind?: string;
      summary?: string;
    }
  | {
      type: "artifact";
      artifactRef: string;
      title: string;
      kind?: string;
      state?: string;
      summary?: string;
    }
  | {
      type: "error";
      title: string;
      message: string;
      code?: string;
    }
  | {
      type: "notice";
      kind: "budget_exhausted";
    }
  | {
      /** Daemon-authored scheduler/control turn, never a human chat message. */
      type: "runtime";
      kind: "loop.tick";
      bindingLabel?: string;
      state: "running" | "completed" | "failed";
      request: string;
      result?: string;
    }
  | {
      /** Channel quote/reply preview shown above the user body. */
      type: "quote";
      text: string;
      senderLabel?: string | null;
    }
  | {
      type: "unknown";
      label: string;
    };

export type ConversationToolState =
  | "pending"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled";

export type ConversationTaskState =
  | "pending"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type ConversationApprovalState =
  | "requested"
  | "resolved"
  | "approved"
  | "rejected"
  | "cancelled";

export type ConversationMessageView = {
  id: string;
  /** Native transcript message id used by lazy media routes. */
  sourceMessageId?: string;
  actor: "user" | "spark" | "session";
  body: string;
  title: string | null;
  status: string | null;
  timestamp: string;
  meta: string | null;
  /** Platform sender or originating session label; null for local user and Spark turns. */
  senderLabel: string | null;
  parts: ConversationPart[];
};

export type ConversationPartLabels = {
  reasoning: string;
  reasoningStreaming: string;
  chain: string;
  chainStreaming: string;
  chainEmpty: string;
  chainFailed: string;
  tool: string;
  task: string;
  approval: string;
  unknown: string;
  collapse: string;
  expand: string;
  budgetExhausted: string;
  budgetExhaustedHint: string;
  runtimeControl: string;
  runtimeTick: string;
  runtimeRequest: string;
  runtimeResult: string;
};

export type ConversationActionView = Readonly<{
  id: string;
  label: string;
  intent: string;
  description?: string;
  payload?: Readonly<Record<string, unknown>>;
  tone?: "default" | "primary" | "danger";
}>;

export type ConversationActionBarView = Readonly<{
  id: string;
  title: string;
  description?: string;
  actions: readonly ConversationActionView[];
}>;

export type ConversationActionAvailability = Readonly<{
  enabled: boolean;
  reason?: string;
}>;

export type ConversationActionBarProps = {
  view: ConversationActionBarView;
  disabled?: boolean;
  disabledReason?: string;
  resolveAction?: (action: ConversationActionView) => ConversationActionAvailability;
  onAction?: (action: ConversationActionView) => void | Promise<void>;
};

/** Compatibility names retained while Hub callers move to presentation-neutral terminology. */
export type SlashActionAvailability = ConversationActionAvailability;
export type SlashActionBarProps = ConversationActionBarProps;

export type SessionQueueItem = Readonly<{
  id: string;
  text: string;
  description?: string;
}>;

export type SessionQueueLabels = Readonly<{
  region: string;
  queued: string;
  next: string;
}>;

export type SessionQueueProps = {
  items: readonly SessionQueueItem[];
  labels: SessionQueueLabels;
  hasRunningTurn: boolean;
  defaultOpen?: boolean;
  actions?: Snippet<[SessionQueueItem]>;
};

export interface SessionStatusBarLabels {
  bar: string;
  workingDirectory: string;
  branch: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  cacheHit: string;
  cost: string;
  context: string;
}

export interface SessionStatusSnapshot {
  cwd: string;
  gitBranch?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  latestCacheHitPercent?: number;
  contextTokens?: number;
  contextTokenSource?: "reported" | "tokenizer" | "estimated";
  contextWindow?: number;
}

/** Result of a scroll-driven "load earlier history" request. */
export type LoadEarlierOutcome = "loaded" | "busy" | "exhausted" | "error";

export type ConversationTurnRailItem = Readonly<{
  id: string;
  label: string;
  summary: string;
  meta: string;
  actor: "user" | "session";
}>;
