import type { SparkSessionView, SparkSessionActivityPhase } from "@zendev-lab/spark-protocol";
import {
  resolveSessionActivityState as resolveProtocolSessionActivityState,
  sessionActivityNeedsStatusProbe as protocolSessionActivityNeedsStatusProbe,
  type SparkSessionActivityState,
} from "@zendev-lab/spark-protocol";
import type { HubPendingTurn } from "./session-pending-turns";

export type SessionActivityPhase = SparkSessionActivityPhase;
export type SessionActivityState = SparkSessionActivityState;

export function sessionActivityNeedsStatusProbe(state: SessionActivityState): boolean {
  return protocolSessionActivityNeedsStatusProbe(state);
}

export function resolveSessionActivityState(input: {
  registryStatus?: string | null;
  session: SparkSessionView | null;
  projectedTurns: readonly HubPendingTurn[];
  liveActiveTurnId?: string | null;
}): SessionActivityState {
  return resolveProtocolSessionActivityState(input);
}
