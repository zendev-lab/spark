import {
  parseSparkHumanWaitRespondent,
  type SparkDirectAnswerProvenance,
} from "@zendev-lab/spark-protocol";
import { SparkDaemonControlError } from "../../control-error.ts";
import {
  SparkDaemonHumanWaitLookupError,
  type SparkDaemonHumanWaitRecord,
} from "../../core/human-waits.ts";
import { requireHumanInteractionResponder, requireHumanWaitRegistry } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type HumanRequest = Extract<
  LocalRpcServiceRequest,
  { method: "human.interaction.list" | "human.interaction.respond" }
>;

export async function handleHumanRequest(
  ctx: LocalRpcDispatchContext,
  request: HumanRequest,
): Promise<LocalRpcServiceOutput<HumanRequest>> {
  const { options } = ctx;
  switch (request.method) {
    case "human.interaction.list": {
      const waits = requireHumanWaitRegistry(options)
        .listPending()
        .filter((wait) => parseSparkHumanWaitRespondent(wait.respondent).kind === "user")
        .filter((wait) => !request.params.sessionId || wait.sessionId === request.params.sessionId);
      return parseLocalRpcServiceOutput(request.method, { waits });
    }
    case "human.interaction.respond": {
      const waits = requireHumanWaitRegistry(options);
      let wait;
      try {
        wait = waits.requireUniquePendingInteraction(request.params);
      } catch (error) {
        if (
          error instanceof SparkDaemonHumanWaitLookupError &&
          error.code === "human_interaction_not_found" &&
          request.params.humanResponseId
        ) {
          wait = waits.requireUniqueInteraction(request.params);
        } else {
          throw error;
        }
      }
      const provenance = request.params.provenance ?? "direct_user";
      authorizeHumanInteractionAnswer(wait, {
        provenance,
        status: request.params.status,
        respondentSessionId: request.params.respondentSessionId,
      });
      const result = await requireHumanInteractionResponder(options)(wait, {
        ...(request.params.humanResponseId
          ? { humanResponseId: request.params.humanResponseId }
          : {}),
        status: request.params.status,
        provenance,
        answers: request.params.answers,
        responseArtifactRefs: request.params.responseArtifactRefs,
      });
      return parseLocalRpcServiceOutput(request.method, result);
    }
    default: {
      const exhaustive: never = request;
      return exhaustive;
    }
  }
}

function authorizeHumanInteractionAnswer(
  wait: SparkDaemonHumanWaitRecord,
  input: {
    provenance: SparkDirectAnswerProvenance;
    status: "answered" | "cancelled";
    respondentSessionId?: string;
  },
): void {
  const respondent = parseSparkHumanWaitRespondent(wait.respondent);
  switch (input.provenance) {
    case "system":
      return;
    case "session": {
      const actor = input.respondentSessionId?.trim();
      if (input.status !== "answered") {
        throw new SparkDaemonControlError(
          "human_interaction_forbidden",
          "session answers can only settle a pending session-addressed ask",
        );
      }
      if (respondent.kind !== "session" || !actor || respondent.sessionId !== actor) {
        throw new SparkDaemonControlError(
          "human_interaction_forbidden",
          "this ask is not addressed to the answering Session",
        );
      }
      if (wait.evidenceRequest) {
        throw new SparkDaemonControlError(
          "human_interaction_forbidden",
          "session answers cannot settle evidence-bound waits",
        );
      }
      return;
    }
    case "direct_user":
      if (respondent.kind !== "user") {
        throw new SparkDaemonControlError(
          "human_interaction_forbidden",
          "this ask is addressed to a Session",
        );
      }
      return;
    default: {
      const exhaustive: never = input.provenance;
      return exhaustive;
    }
  }
}
