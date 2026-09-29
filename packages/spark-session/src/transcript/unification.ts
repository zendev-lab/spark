import { resolve } from "node:path";
import {
  KNOWN_SESSION_EVENT_TYPES,
  interruptedTurnClosers,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import {
  dshDocumentToSparkRecord,
  encodeSparkRecordAsDsh,
  isRecord,
  nativeMessageMetadata,
  type EncodeSparkRecordAsDshOptions,
  type SparkDshSessionDocument,
} from "./dsh-format.ts";
import { remapSparkDshEvent } from "./event-references.ts";
import type { SparkSessionEntry, SparkSessionRecord } from "./types.ts";

/** Prepare a backed-up offline migration; ordinary saves never combine logs. */
export async function mergeSparkSessionRecords(
  records: readonly SparkSessionRecord[],
  targetPath: string,
  targetCwd: string,
  options: EncodeSparkRecordAsDshOptions,
): Promise<SparkSessionRecord> {
  const first = records[0];
  if (!first) throw new Error("at least one transcript record is required");
  if (records.length === 1) {
    const document = await encodeSparkRecordAsDsh(
      { ...first, header: { ...first.header, cwd: resolve(targetCwd) } },
      options,
    );
    return dshDocumentToSparkRecord(targetPath, document);
  }
  const entries: SparkSessionEntry[] = [];
  const ids = new Set<string>();
  let combined: SparkDshSessionDocument | undefined;
  let turnOffset = 0;
  let systemSeq: number | undefined;
  for (const record of records) {
    if (
      record.header.id !== first.header.id ||
      record.header.seedLength !== undefined ||
      record.header.parentSessionId
    ) {
      throw new Error(
        `Cannot combine independent or inherited transcript lineages: ${record.path}`,
      );
    }
    const fragment = structuredClone(record.entries);
    const roots = fragment.filter((entry) => entry.parentId === null);
    if (fragment.length > 0 && roots.length !== 1)
      throw new Error(`transcript ${record.path} has ${roots.length} roots`);
    for (const entry of fragment) {
      if (ids.has(entry.id))
        throw new Error(`duplicate transcript entry id ${entry.id} in ${record.path}`);
      ids.add(entry.id);
    }
    const previousLeaf = entries.at(-1);
    if (roots[0] && previousLeaf) roots[0].parentId = previousLeaf.id;
    const entryOffset = entries.length;
    entries.push(...fragment);
    const document = await encodeSparkRecordAsDsh(record, options);
    combined ??= { header: { ...document.header, cwd: resolve(targetCwd) }, events: [] };
    combined.events.push(...interruptedTurnClosers(combined.events as SessionEvent[]));
    const mapping: number[] = [];
    let fragmentTurns = 0;
    for (const source of document.events) {
      const event = remapSparkDshEvent(structuredClone(source), combined.events.length, mapping);
      mapping[source.seq] = event.seq;
      if (
        KNOWN_SESSION_EVENT_TYPES.has(event.type) &&
        isRecord(event.data) &&
        typeof event.data.turn === "number"
      ) {
        fragmentTurns = Math.max(fragmentTurns, event.data.turn);
        event.data.turn += turnOffset;
      }
      if (event.type === "system/message") {
        if (event.surfaceOp === "append" && systemSeq !== undefined) {
          event.surfaceOp = { op: "replace", startSeq: systemSeq, endSeq: systemSeq };
          event.sourceEventSeqs = [systemSeq];
        }
        systemSeq = event.seq;
      }
      if (
        (event.type === "spark/record" || event.type === "spark/message-meta") &&
        isRecord(event.data) &&
        isRecord(event.data.entry)
      ) {
        event.data.position = Number(event.data.position) + entryOffset;
        const entryId = event.data.entry.id;
        const entry = fragment.find((candidate) => candidate.id === entryId);
        if (entry) event.data.entry.parentId = entry.parentId;
      }
      combined.events.push(event);
    }
    turnOffset += fragmentTurns;
  }
  const document = combined!;
  // Bind the final projection after every fragment, including an unbridged native tail.
  for (const [position, entry] of entries.entries()) {
    const native =
      entry.type === "message" && entry.message.role === "toolResult"
        ? document.events.findLast(
            (event) =>
              event.type === "tool/result" &&
              isRecord(event.data) &&
              isRecord(event.data.message) &&
              event.data.message.id === entry.id,
          )
        : undefined;
    document.events.push({
      seq: document.events.length,
      time: Date.parse(entry.timestamp),
      ignorable: true,
      type: native ? "spark/message-meta" : "spark/record",
      data:
        native && entry.type === "message"
          ? await nativeMessageMetadata(position, entry, native.seq, options.attachmentRoot)
          : { position, entry },
    });
  }
  return dshDocumentToSparkRecord(targetPath, document);
}
