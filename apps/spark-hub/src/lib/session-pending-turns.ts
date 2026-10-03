import {
  resolveSessionPendingTurns as resolveProtocolSessionPendingTurns,
  type SparkPendingTurn,
} from "@zendev-lab/spark-protocol";
import type { SparkSessionView } from "@zendev-lab/spark-protocol";

export type HubPendingTurn = SparkPendingTurn;

export function resolveSessionPendingTurns(
  projected: readonly HubPendingTurn[],
  session: SparkSessionView | null,
): HubPendingTurn[] {
  return resolveProtocolSessionPendingTurns(projected, session);
}
