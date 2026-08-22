import type {
  SparkLocalRpcInput,
  SparkLocalRpcMethod,
  SparkLocalRpcOutput,
} from "@zendev-lab/spark-protocol/local-rpc-orpc-contract";

export async function webRpc<M extends SparkLocalRpcMethod>(
  method: M,
  input: SparkLocalRpcInput<M>,
): Promise<SparkLocalRpcOutput<M>> {
  const response = await fetch("/api/v1/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, input }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
    const message =
      typeof body?.message === "string" && body.message.trim().length > 0
        ? body.message
        : `spark web RPC ${method} failed: ${response.status}`;
    throw new Error(message);
  }
  const body = (await response.json()) as { output: SparkLocalRpcOutput<M> };
  return body.output;
}
