import type { DatabaseSync } from "node:sqlite";
import {
  isSparkLocalRpcOrpcErrorCodeForMethod,
  type SparkLocalRpcMethod,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";
import type { SparkPaths } from "@zendev-lab/spark-system";
import { localRpcError } from "./helpers.ts";
import { isRecord } from "./is-record.ts";
import { parseLocalRpcRequest } from "./parse.ts";
import { invokeParsedLocalRpcService } from "./service.ts";
import type { LocalRpcHandlerOptions, LocalRpcResponse } from "./types.ts";

export async function handleLocalRpcLine(
  line: string,
  paths: SparkPaths,
  db: DatabaseSync,
  onStop: (() => void | Promise<void>) | undefined,
  options: LocalRpcHandlerOptions = {},
): Promise<LocalRpcResponse> {
  let requestId = "unknown";
  let parsedMethod: SparkLocalRpcMethod | undefined;
  try {
    try {
      const raw = JSON.parse(line) as unknown;
      if (isRecord(raw) && typeof raw.id === "string" && raw.id.trim()) {
        requestId = raw.id;
      }
    } catch {
      // parseLocalRpcRequest below owns the JSON/shape error message.
    }
    const request = parseLocalRpcRequest(line);
    parsedMethod = request.method;
    requestId = request.id;
    const result = await invokeParsedLocalRpcService(request, {
      paths,
      db,
      ...(onStop ? { onStop } : {}),
      handlerOptions: options,
    });
    return { id: request.id, ok: true, result };
  } catch (error) {
    const mapped = localRpcError(error);
    return {
      id: requestId,
      ok: false,
      error:
        parsedMethod &&
        (!mapped.code || !isSparkLocalRpcOrpcErrorCodeForMethod(parsedMethod, mapped.code))
          ? {
              message: "Spark daemon request failed.",
              code: "INTERNAL_SERVER_ERROR",
            }
          : mapped,
    };
  }
}
