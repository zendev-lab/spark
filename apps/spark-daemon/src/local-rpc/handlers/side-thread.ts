import { executeSparkDaemonSideThreadControl } from "../../side-thread-control.ts";
import { sessionControlOptions } from "../helpers.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import {
  parseLocalRpcServiceOutput,
  type LocalRpcServiceOutput,
  type LocalRpcServiceRequest,
} from "../types.ts";

type SideThreadRequest = Extract<
  LocalRpcServiceRequest,
  {
    method:
      | "side-thread.ensure"
      | "side-thread.snapshot"
      | "side-thread.submit"
      | "side-thread.reset"
      | "side-thread.configure"
      | "side-thread.handoff";
  }
>;

export async function handleSideThreadRequest(
  ctx: LocalRpcDispatchContext,
  request: SideThreadRequest,
): Promise<LocalRpcServiceOutput<SideThreadRequest>> {
  const executed = await executeSparkDaemonSideThreadControl(
    sessionControlOptions(ctx.paths, ctx.db, ctx.options),
    {
      kind: `${request.method}.request` as
        | "side-thread.ensure.request"
        | "side-thread.snapshot.request"
        | "side-thread.submit.request"
        | "side-thread.reset.request"
        | "side-thread.configure.request"
        | "side-thread.handoff.request",
      payload: request.params,
    },
  );
  return parseLocalRpcServiceOutput(request.method, executed.result);
}
