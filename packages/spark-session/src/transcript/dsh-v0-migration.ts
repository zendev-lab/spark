import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import {
  SessionFormatEventCollector,
  isSessionFormatJsonObject,
  type SessionFormatEvent,
  type SessionFormatHeader,
  type SessionFormatJsonValue,
} from "@deepseek-ai/dsh-session-format";
import {
  RELEASED_V0_EVENT_DISPOSITIONS,
  sessionFormatV0ToV1,
} from "@deepseek-ai/dsh-session-format-v0-to-v1";
import {
  createSessionFormatV3ToV4,
  restoreReleasedV4Artifact,
} from "@deepseek-ai/dsh-session-format-v3-to-v4";
import { remapSparkDshEvent } from "./event-references.ts";
import { restoreLegacyDshSession } from "./legacy-dsh-session.js";
import type { SparkDshSessionDocument, SparkDshSessionEvent } from "./dsh-types.ts";

/** Migrate Spark's logical v0 framing without replaying its message projection. */
export function migrateSparkDshV0(
  document: SparkDshSessionDocument,
  children: readonly SessionFormatJsonValue[] = [],
): SparkDshSessionDocument {
  restoreLegacyDshSession(document);
  const { seedLength, ...legacyHeader } = document.header;
  const sourceHeader = {
    ...legacyHeader,
    ...(legacyHeader.agentPreset === "code" ? { agentPreset: "ptc" } : {}),
    isSeeded: seedLength !== undefined,
    delegationDepth: legacyHeader.delegationDepth ?? 0,
  } as SessionFormatHeader;
  const normalizer = sessionFormatV0ToV1.createStage({
    sourceHeader,
    targetHeader: { ...sourceHeader, version: 1 },
    sourceInheritedEventCount: seedLength ?? 0,
    sourceKind: "decoded",
  });
  const normalized = new SessionFormatEventCollector();
  for (const source of document.events) {
    const event = source as SessionFormatEvent;
    if (
      event.type.startsWith("spark/") ||
      (event.ignorable === true && !RELEASED_V0_EVENT_DISPOSITIONS[event.type])
    ) {
      normalized.emitEvent(event);
    } else {
      normalizer.transformEvent(event, normalized);
    }
  }
  normalizer.finish(normalized);

  const events: SparkDshSessionEvent[] = [];
  const mapping: number[] = [];
  let turn: number | undefined;
  let step: number | undefined;
  let shiftedTurn: number | undefined;
  let systemSeq: number | undefined;
  let systemText = "";
  const emit = (type: string, time: number, data: unknown, rest = {}): number => {
    const seq = events.length;
    events.push({ type, seq, time, data, ...rest });
    return seq;
  };
  const system = (text: string, anchor: SessionFormatEvent): void => {
    if (turn === undefined || step === undefined) {
      throw new Error(`Spark v0 system prompt outside an open step at ${anchor.seq}`);
    }
    const previous = systemSeq;
    systemSeq = emit(
      "system/message",
      anchor.time,
      {
        turn,
        step,
        message: {
          id: `spark-v0-system:${document.header.id}:${anchor.seq}`,
          role: "system",
          source: { kind: "system-prompt" },
          content: text ? [{ type: "text", text }] : [],
        },
      },
      previous === undefined
        ? { surfaceOp: "append" }
        : {
            surfaceOp: { op: "replace", startSeq: previous, endSeq: previous },
            sourceEventSeqs: [previous],
          },
    );
    systemText = text;
  };

  for (const source of normalized.values) {
    if (
      !source.type.startsWith("spark/") &&
      source.ignorable === true &&
      !RELEASED_V0_EVENT_DISPOSITIONS[source.type]
    ) {
      mapping[source.seq] = events.length;
      events.push({ ...structuredClone(source), seq: events.length } as SparkDshSessionEvent);
      continue;
    }
    const data = structuredClone(source.data) as Record<string, unknown>;
    let type = source.type;
    if (type === "turn/start") turn = data.turn as number;
    if (type === "step/start") step = (data.step as number) + (turn === shiftedTurn ? 1 : 0);
    if (type === "user/message" && systemSeq === undefined) {
      if (turn === undefined) throw new Error("Spark v0 first message has no owning turn");
      // The old Spark writer put the user before step 1. A closed empty step
      // establishes the required system head without moving any source event.
      if (step !== undefined) {
        system("", source);
      } else {
        shiftedTurn = turn;
        step = 1;
        emit("step/start", source.time, { turn, step });
        system("", source);
        emit("step/end", source.time, { turn, step });
        step = undefined;
      }
    }
    if (typeof data.step === "number" && data.turn === shiftedTurn) data.step += 1;
    if (type === "request/header") {
      const header = data.header as Record<string, unknown>;
      const text = typeof header.system === "string" ? header.system : "";
      if (text !== systemText || systemSeq === undefined) system(text, source);
      delete header.system;
    }
    if (type === "assistant/chunk") {
      type = "spark/legacy-assistant-chunk";
    } else if (type === "assistant/message") {
      data.stream = ((source.sourceEventSeqs ?? []) as number[]).map((seq) => {
        const chunk = normalized.values[seq];
        if (
          chunk?.type !== "assistant/chunk" ||
          !isSessionFormatJsonObject(chunk.data) ||
          chunk.data.turn !== (source.data as Record<string, unknown>).turn ||
          chunk.data.step !== (source.data as Record<string, unknown>).step
        ) {
          throw new Error(`Spark v0 assistant message cites an unrelated chunk at ${seq}`);
        }
        return { type: "chunk", time: chunk.time, chunk: chunk.data.chunk };
      });
    } else if (type === "session/end-seed") {
      data.inherited = source.seq === seedLength;
    } else if (type === "tool/code-dispatch" || type === "tool/code-dispatch-start") {
      type = type.replace("code-", "ptc-");
    } else if (type === "spark/meta") {
      data.sparkVersion = 5;
    }
    const target = remapSparkDshEvent(
      { ...source, type, data } as SparkDshSessionEvent,
      events.length,
      mapping,
    );
    if (type === "assistant/message") delete target.sourceEventSeqs;
    if (type === "spark/legacy-assistant-chunk") target.ignorable = true;
    mapping[source.seq] = target.seq;
    events.push(target);
    if (type === "step/start" && systemSeq === undefined) system("", source);
    if (type === "step/end") step = undefined;
    if (type === "turn/end") {
      turn = undefined;
      step = undefined;
    }
  }
  let cut = seedLength === undefined ? 0 : mapping[seedLength];
  if (seedLength !== undefined && cut === undefined && seedLength === document.events.length) {
    cut = emit("session/end-seed", document.events.at(-1)?.time ?? document.header.createdAt, {
      inherited: true,
    });
  }
  if (cut === undefined) throw new Error("Spark v0 inherited cut is outside its event log");

  const migration = createSessionFormatV3ToV4(children);
  const header = { ...sourceHeader, version: 3 };
  const targetHeader = migration.migrateHeader(header);
  const stage = migration.createStage({
    sourceHeader: header,
    targetHeader,
    sourceInheritedEventCount: cut,
    sourceKind: "transformed",
  });
  const current = new SessionFormatEventCollector();
  const currentMapping: number[] = [];
  for (const event of events) {
    stage.transformEvent(event as SessionFormatEvent, current);
    currentMapping[event.seq] = current.values.length - 1;
  }
  const inheritedEventCount = stage.finish(current);
  // Upstream treats extension payloads as opaque. Spark owns its eventSeq
  // references and retains its producer names instead of the legacy namespace.
  for (const event of events) {
    if (!event.type.startsWith("spark/")) continue;
    const seq = currentMapping[event.seq]!;
    current.values[seq] = remapSparkDshEvent(event, seq, currentMapping) as SessionFormatEvent;
  }
  restoreReleasedV4Artifact(
    { header: targetHeader, inheritedEventCount, events: current.values },
    KNOWN_SESSION_EVENT_TYPES,
  );
  return {
    header: { ...targetHeader, inheritedEventCount } as SparkDshSessionDocument["header"],
    events: current.values as SparkDshSessionEvent[],
  };
}
