import type { SessionHeader, SessionId } from "@deepseek-ai/dsh-session";

export interface SparkDshSessionHeader extends Omit<SessionHeader, "version" | "isSeeded"> {
  isSeeded?: boolean;
  seedLength?: number;
  inheritedEventCount?: number;
  version: number;
  id: ReturnType<typeof SessionId>;
}

export interface SparkDshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  ignorable?: true;
  sourceEventSeqs?: number[];
  surfaceOp?:
    | "append"
    | { op: "replace"; start: number; end: number }
    | { op: "replace"; startSeq: number; endSeq: number };
}

export interface SparkDshSessionDocument {
  header: SparkDshSessionHeader;
  events: SparkDshSessionEvent[];
}
