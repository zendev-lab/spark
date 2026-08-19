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
    throw new Error(`spark web RPC ${method} failed: ${response.status}`);
  }
  const body = (await response.json()) as { output: SparkLocalRpcOutput<M> };
  return body.output;
}
