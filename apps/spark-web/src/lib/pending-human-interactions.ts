import {
  sparkAskQuestionViewSchema,
  type SparkAskQuestionView,
  type SparkInteractionRequest,
} from "@zendev-lab/spark-protocol";
import type { SparkLocalRpcOutput } from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";

type ListedHumanWait = SparkLocalRpcOutput<"human.interaction.list">["waits"][number];
type PendingHumanInteractionInput = Omit<ListedHumanWait, "questions"> & {
  questions: readonly unknown[];
};

export interface PendingHumanInteraction {
  interactionRequestId: string;
  title: string;
  prompt: string;
  mode?: Extract<SparkInteractionRequest, { kind: "askFlow" }>["mode"];
  questions: SparkAskQuestionView[];
}

const pendingQuestionsSchema = sparkAskQuestionViewSchema.array().min(1);

export function parsePendingHumanInteractions(result: {
  waits: readonly PendingHumanInteractionInput[];
}): PendingHumanInteraction[] {
  return result.waits
    .filter((wait) => wait.status === "pending")
    .map((wait) => ({
      interactionRequestId: wait.interactionRequestId,
      title: wait.title,
      prompt: wait.prompt,
      ...(wait.mode ? { mode: wait.mode } : {}),
      questions: pendingQuestionsSchema.parse(wait.questions),
    }));
}
