import { sparkActionViewSchema } from "@zendev-lab/spark-protocol/presentation";
import { type SparkActionView } from "@zendev-lab/spark-protocol/presentation";
import type { ConversationActionView } from "@zendev-lab/spark-ui/conversation";

/** Revalidate presentation callbacks before they reach Hub's trusted Spark action handlers. */
export function sparkActionFromPresentation(action: ConversationActionView): SparkActionView {
  return sparkActionViewSchema.parse(action);
}
