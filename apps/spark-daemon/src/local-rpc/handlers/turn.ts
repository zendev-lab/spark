import {
  sparkInvocationRetentionApplyResultSchema,
  sparkInvocationRetentionPreviewResultSchema,
  sparkInvocationRetryResultSchema,
} from "@zendev-lab/spark-protocol/daemon";
import { SparkInvocationStore } from "../../store/invocations.ts";
import { executeSparkDaemonSessionControl } from "../../session-control.ts";
import {
  invocationListResult,
  invocationResult,
  sessionControlOptions,
  settleManagedSessionTurn,
} from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type TurnRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "turn.submit"
      | "turn.status"
      | "turn.result"
      | "turn.stream"
      | "turn.cancel"
      | "invocation.list"
      | "invocation.retry"
      | "invocation.retention.preview"
      | "invocation.retention.apply";
  }
>;

export async function handleTurnRequest(
  ctx: LocalRpcDispatchContext,
  request: TurnRequest,
): Promise<LocalRpcServiceOutput<TurnRequest>> {
  const { paths, db, options } = ctx;
  switch (request.method) {
    case "turn.submit": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        {
          kind: "turn.submit.request",
          scope: "any",
          sessionId: request.params.sessionId,
          idempotencyKey: request.params.idempotencyKey,
          payload: { ...request.params },
        },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result);
    }
    case "turn.status": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "turn.status.request", scope: "any", payload: { ...request.params } },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result);
    }
    case "turn.result": {
      return invocationResult(new SparkInvocationStore(db), request.params.invocationId);
    }
    case "invocation.list": {
      return invocationListResult(new SparkInvocationStore(db), request.params);
    }
    case "invocation.retry": {
      const store = new SparkInvocationStore(db);
      const retryKey = `invocation.retry:${request.params.invocationId}`;
      const existing = store.findByIdempotencyKey(retryKey);
      const original = store.require(request.params.invocationId);
      if (!existing && original.sessionId) {
        await options.sessionRegistry?.recordTurnQueued(original.sessionId);
      }
      let retried;
      try {
        retried = store.retry(request.params.invocationId);
      } catch (error) {
        if (!existing && original.sessionId) {
          await settleManagedSessionTurn(options.sessionRegistry, original.sessionId);
        }
        throw error;
      }
      return sparkInvocationRetryResultSchema.parse({
        invocationId: retried.invocationId,
        retryOfInvocationId: request.params.invocationId,
        status: "queued",
        acceptedAt: retried.createdAt,
      });
    }
    case "invocation.retention.preview": {
      const preview = new SparkInvocationStore(db).retentionPreview(
        request.params.before,
        request.params.limit,
      );
      return sparkInvocationRetentionPreviewResultSchema.parse({
        ...preview,
        dryRun: true,
        observedAt: new Date().toISOString(),
      });
    }
    case "invocation.retention.apply": {
      const appliedAt = new Date().toISOString();
      const result = new SparkInvocationStore(db).retentionApply(request.params.before, {
        invocationLimit: request.params.invocationLimit,
        eventLimit: request.params.eventLimit,
        now: appliedAt,
      });
      return sparkInvocationRetentionApplyResultSchema.parse({
        ...result,
        appliedAt,
      });
    }
    case "turn.stream": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "turn.stream.subscribe", scope: "any", payload: { ...request.params } },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result);
    }
    case "turn.cancel": {
      const executed = await executeSparkDaemonSessionControl(
        sessionControlOptions(paths, db, options),
        { kind: "turn.cancel.request", scope: "any", payload: { ...request.params } },
      );
      return parseLocalRpcServiceOutput(request.method, executed.result);
    }
  }
}
