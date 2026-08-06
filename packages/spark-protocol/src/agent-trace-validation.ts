import type { SparkAgentTraceEvent } from "./agent-trace-schema.ts";

type RunStartedEvent = Extract<SparkAgentTraceEvent, { kind: "agent.run.started" }>;
type RoundtripStartedEvent = Extract<SparkAgentTraceEvent, { kind: "model.roundtrip.started" }>;
type SkillLoadStartedEvent = Extract<SparkAgentTraceEvent, { kind: "skill.load.started" }>;
type ToolCallStartedEvent = Extract<SparkAgentTraceEvent, { kind: "tool.call.started" }>;

type StartedTraceEvent =
  | RunStartedEvent
  | RoundtripStartedEvent
  | SkillLoadStartedEvent
  | ToolCallStartedEvent;

type OpenSpan = {
  started: StartedTraceEvent;
  finished: boolean;
};

export type SparkAgentTraceValidationIssueCode =
  | "duplicate_event"
  | "trace_mismatch"
  | "root_order"
  | "duplicate_span"
  | "missing_parent"
  | "invalid_parent"
  | "parent_closed"
  | "orphan_finish"
  | "finish_kind_mismatch"
  | "duplicate_finish"
  | "span_metadata_mismatch"
  | "unclosed_span"
  | "roundtrip_count_mismatch";

export interface SparkAgentTraceValidationIssue {
  code: SparkAgentTraceValidationIssueCode;
  message: string;
  eventIndex?: number;
  eventId?: string;
}

export interface SparkAgentTraceValidationResult {
  valid: boolean;
  issues: SparkAgentTraceValidationIssue[];
}

/** Validate a terminal trace after daemon ordering and event deduplication. */
export function validateCompletedSparkAgentTrace(
  events: readonly SparkAgentTraceEvent[],
): SparkAgentTraceValidationResult {
  const issues: SparkAgentTraceValidationIssue[] = [];
  const eventIds = new Set<string>();
  const spans = new Map<string, OpenSpan>();
  const instantSpanIds = new Set<string>();
  let traceId: string | undefined;
  let runSpanId: string | undefined;
  let runFinishedIndex: number | undefined;
  let observedRoundtrips = 0;
  let reportedRoundtrips: number | undefined;

  const issue = (
    code: SparkAgentTraceValidationIssueCode,
    message: string,
    event?: SparkAgentTraceEvent,
    eventIndex?: number,
  ): void => {
    issues.push({
      code,
      message,
      ...(eventIndex !== undefined ? { eventIndex } : {}),
      ...(event ? { eventId: event.eventId } : {}),
    });
  };

  const registerStart = (event: StartedTraceEvent, eventIndex: number): void => {
    if (spans.has(event.spanId) || instantSpanIds.has(event.spanId)) {
      issue("duplicate_span", `span ${event.spanId} was already registered`, event, eventIndex);
      return;
    }
    spans.set(event.spanId, { started: event, finished: false });
  };

  for (const [eventIndex, event] of events.entries()) {
    validateEventIdentity(event, eventIndex);
    validateEventParent(event, eventIndex);
    consumeEvent(event, eventIndex);
  }

  validateRoot();
  validateClosedSpans();
  validateRoundtripCount();

  return { valid: issues.length === 0, issues };

  function validateEventIdentity(event: SparkAgentTraceEvent, eventIndex: number): void {
    if (eventIds.has(event.eventId)) {
      issue("duplicate_event", `event ${event.eventId} appears more than once`, event, eventIndex);
    }
    eventIds.add(event.eventId);

    traceId ??= event.traceId;
    if (event.traceId !== traceId) {
      issue(
        "trace_mismatch",
        `expected trace ${traceId}, observed ${event.traceId}`,
        event,
        eventIndex,
      );
    }

    if (runFinishedIndex !== undefined) {
      issue("root_order", "events cannot appear after agent.run.finished", event, eventIndex);
    }
  }

  function validateEventParent(event: SparkAgentTraceEvent, eventIndex: number): void {
    if (!("parentSpanId" in event)) return;

    const parent = spans.get(event.parentSpanId);
    if (!parent) {
      issue(
        "missing_parent",
        `parent span ${event.parentSpanId} has not started`,
        event,
        eventIndex,
      );
      return;
    }

    const expectedKind = expectedParentKind(event);
    if (expectedKind !== undefined && parent.started.kind !== expectedKind) {
      issue(
        "invalid_parent",
        `${event.kind} requires parent ${expectedKind}, ` + `observed ${parent.started.kind}`,
        event,
        eventIndex,
      );
    }

    if (parent.finished) {
      issue(
        "parent_closed",
        `parent span ${event.parentSpanId} already finished`,
        event,
        eventIndex,
      );
    }
  }

  function consumeEvent(event: SparkAgentTraceEvent, eventIndex: number): void {
    switch (event.kind) {
      case "agent.run.started":
        if (eventIndex !== 0 || runSpanId !== undefined) {
          issue(
            "root_order",
            "agent.run.started must be the unique first event",
            event,
            eventIndex,
          );
        }
        runSpanId ??= event.spanId;
        registerStart(event, eventIndex);
        return;
      case "model.roundtrip.started":
        observedRoundtrips += 1;
        registerStart(event, eventIndex);
        return;
      case "skill.load.started":
      case "tool.call.started":
        registerStart(event, eventIndex);
        return;
      case "skill.selection.finished":
        registerInstantEvent(event, eventIndex);
        return;
      case "agent.run.finished":
      case "model.roundtrip.finished":
      case "skill.load.finished":
      case "tool.call.finished":
        finishSpan(event, eventIndex);
        return;
    }
  }

  function registerInstantEvent(
    event: Extract<SparkAgentTraceEvent, { kind: "skill.selection.finished" }>,
    eventIndex: number,
  ): void {
    if (spans.has(event.spanId) || instantSpanIds.has(event.spanId)) {
      issue("duplicate_span", `span ${event.spanId} was already registered`, event, eventIndex);
    }
    instantSpanIds.add(event.spanId);
  }

  function finishSpan(
    event: Extract<
      SparkAgentTraceEvent,
      {
        kind:
          | "agent.run.finished"
          | "model.roundtrip.finished"
          | "skill.load.finished"
          | "tool.call.finished";
      }
    >,
    eventIndex: number,
  ): void {
    const span = spans.get(event.spanId);
    if (!span) {
      issue("orphan_finish", `span ${event.spanId} finished without a start`, event, eventIndex);
      return;
    }

    const expectedKind = expectedStartKind(event.kind);
    if (span.started.kind !== expectedKind) {
      issue(
        "finish_kind_mismatch",
        `${event.kind} cannot finish ${span.started.kind}`,
        event,
        eventIndex,
      );
    }

    if (span.finished) {
      issue("duplicate_finish", `span ${event.spanId} finished more than once`, event, eventIndex);
    }
    span.finished = true;

    validateFinishedMetadata(span.started, event, eventIndex);

    if (event.kind === "agent.run.finished") {
      if (event.spanId !== runSpanId) {
        issue("span_metadata_mismatch", "run finish does not match run start", event, eventIndex);
      }
      reportedRoundtrips = event.roundtrips;
      runFinishedIndex = eventIndex;
    }
  }

  function validateFinishedMetadata(
    started: StartedTraceEvent,
    finished: Extract<
      SparkAgentTraceEvent,
      {
        kind:
          | "agent.run.finished"
          | "model.roundtrip.finished"
          | "skill.load.finished"
          | "tool.call.finished";
      }
    >,
    eventIndex: number,
  ): void {
    if (
      started.kind === "model.roundtrip.started" &&
      finished.kind === "model.roundtrip.finished" &&
      started.roundtrip !== finished.roundtrip
    ) {
      issue(
        "span_metadata_mismatch",
        "roundtrip finish does not match start",
        finished,
        eventIndex,
      );
    }

    if (
      started.kind === "skill.load.started" &&
      finished.kind === "skill.load.finished" &&
      !sameSkillLoad(started, finished)
    ) {
      issue(
        "span_metadata_mismatch",
        "Skill load finish does not match start",
        finished,
        eventIndex,
      );
    }

    if (
      started.kind === "tool.call.started" &&
      finished.kind === "tool.call.finished" &&
      !sameToolCall(started, finished)
    ) {
      issue(
        "span_metadata_mismatch",
        "Tool call finish does not match start",
        finished,
        eventIndex,
      );
    }
  }

  function validateRoot(): void {
    if (events.length === 0 || events[0]?.kind !== "agent.run.started") {
      issue("root_order", "completed trace requires agent.run.started", events[0], 0);
    }

    if (runFinishedIndex === undefined) {
      issue("root_order", "completed trace requires agent.run.finished", events.at(-1));
      return;
    }

    if (runFinishedIndex !== events.length - 1) {
      issue(
        "root_order",
        "agent.run.finished must be the final event",
        events[runFinishedIndex],
        runFinishedIndex,
      );
    }
  }

  function validateClosedSpans(): void {
    for (const [spanId, span] of spans) {
      if (!span.finished) {
        issue("unclosed_span", `span ${spanId} has no terminal event`, span.started);
      }
    }
  }

  function validateRoundtripCount(): void {
    if (reportedRoundtrips === undefined || reportedRoundtrips === observedRoundtrips) {
      return;
    }

    issue(
      "roundtrip_count_mismatch",
      `run reported ${reportedRoundtrips} roundtrips, ` + `observed ${observedRoundtrips}`,
      runFinishedIndex === undefined ? undefined : events[runFinishedIndex],
      runFinishedIndex,
    );
  }
}

function expectedParentKind(event: SparkAgentTraceEvent): StartedTraceEvent["kind"] | undefined {
  switch (event.kind) {
    case "model.roundtrip.started":
    case "model.roundtrip.finished":
    case "skill.selection.finished":
    case "skill.load.started":
    case "skill.load.finished":
      return "agent.run.started";
    case "tool.call.started":
    case "tool.call.finished":
      return "model.roundtrip.started";
    default:
      return undefined;
  }
}

function expectedStartKind(
  finishKind:
    | "agent.run.finished"
    | "model.roundtrip.finished"
    | "skill.load.finished"
    | "tool.call.finished",
): StartedTraceEvent["kind"] {
  switch (finishKind) {
    case "agent.run.finished":
      return "agent.run.started";
    case "model.roundtrip.finished":
      return "model.roundtrip.started";
    case "skill.load.finished":
      return "skill.load.started";
    case "tool.call.finished":
      return "tool.call.started";
  }
}

function sameSkillLoad(
  started: SkillLoadStartedEvent,
  finished: Extract<SparkAgentTraceEvent, { kind: "skill.load.finished" }>,
): boolean {
  return (
    started.appliesFromRoundtrip === finished.appliesFromRoundtrip &&
    started.skill.name === finished.skill.name &&
    started.skill.version === finished.skill.version &&
    started.skill.contentHash === finished.skill.contentHash
  );
}

function sameToolCall(
  started: ToolCallStartedEvent,
  finished: Extract<SparkAgentTraceEvent, { kind: "tool.call.finished" }>,
): boolean {
  return (
    started.roundtrip === finished.roundtrip &&
    started.toolCallId === finished.toolCallId &&
    started.toolName === finished.toolName
  );
}
