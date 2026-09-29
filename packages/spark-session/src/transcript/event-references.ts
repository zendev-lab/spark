import type { SparkDshSessionEvent } from "./dsh-types.ts";

/** Only same-log event references move; tool JSON and captured generations do not. */
export function remapSparkDshEvent(
  event: SparkDshSessionEvent,
  seq: number,
  mapping: readonly number[],
): SparkDshSessionEvent {
  const one = (value: unknown): number => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= event.seq ||
      mapping[value] === undefined
    ) {
      throw new Error(`Invalid transcript event reference ${String(value)} at ${event.seq}`);
    }
    return mapping[value]!;
  };
  const list = (values: unknown): number[] => (values as unknown[]).map(one);
  const range = (value: unknown): Record<string, unknown> => {
    const object = value as Record<string, unknown>;
    return { ...object, start: one(object.start), end: one(object.end) };
  };
  let data = event.data as Record<string, unknown>;
  if (event.type === "spark/message-meta") data = { ...data, eventSeq: one(data.eventSeq) };
  if (event.type === "spark/commit") data = { ...data, throughSeq: one(data.throughSeq) };
  if (event.type === "developer/message" && data.headerSeq !== undefined)
    data = { ...data, headerSeq: one(data.headerSeq) };
  if (event.type === "image/offload")
    data = {
      ...data,
      targets: (data.targets as Record<string, unknown>[]).map((target) => ({
        ...target,
        seq: one(target.seq),
      })),
    };
  if (event.type === "command/done" && data.sourceEventSeq !== undefined)
    data = { ...data, sourceEventSeq: one(data.sourceEventSeq) };
  if (event.type === "compaction/summary" || event.type === "compaction/prune")
    data = {
      ...data,
      shadowedRange: range(data.shadowedRange),
      shadowedSeqs: list(data.shadowedSeqs),
    };
  if (event.type === "session/title" || event.type === "session/title-llm-request")
    data = { ...data, messageSeqs: list(data.messageSeqs) };
  const operation = event.surfaceOp;
  return {
    ...event,
    seq,
    data,
    ...(event.sourceEventSeqs ? { sourceEventSeqs: list(event.sourceEventSeqs) } : {}),
    ...(operation && operation !== "append"
      ? {
          surfaceOp: {
            op: "replace",
            startSeq: one("startSeq" in operation ? operation.startSeq : operation.start),
            endSeq: one("endSeq" in operation ? operation.endSeq : operation.end),
          },
        }
      : {}),
  };
}
