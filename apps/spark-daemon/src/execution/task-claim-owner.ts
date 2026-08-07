import type { DatabaseSync } from "node:sqlite";

import { parseLocalRpcInput } from "../local-rpc/parse.ts";
import {
  acquireMainTaskClaim,
  recoverMainTaskClaim,
  releaseMainTaskClaim,
} from "../task-claims/authority.ts";
import type { ExecutionOwnerHandlers } from "./owner-capabilities.ts";

/** Reuse the authoritative local-RPC parser and Task Claim owner operations. */
export function createTaskClaimExecutionOwner(
  db: DatabaseSync,
): ExecutionOwnerHandlers["taskClaim"] {
  return (request) => {
    const action = request.action;
    const params = request.params;
    if (action === "acquire") {
      return acquireMainTaskClaim(db, parseLocalRpcInput("task.claim.acquire", params));
    }
    if (action === "release") {
      return releaseMainTaskClaim(db, parseLocalRpcInput("task.claim.release", params));
    }
    if (action === "recover") {
      return recoverMainTaskClaim(db, parseLocalRpcInput("task.claim.recover", params));
    }
    throw new Error(`unknown Task Claim execution capability action: ${String(action)}`);
  };
}
