import { pathToFileURL } from "node:url";

const loopbackAddress = "127.0.0.1";

export function createHubHealthcheckRequest(env = process.env) {
  const port = env.PORT?.trim() || "5173";
  const url = new URL(`http://${loopbackAddress}:${port}/api/v1/health`);
  const headers = {};

  const trustProxy = env.SPARK_HUB_TRUST_PROXY?.trim();
  if (trustProxy === "loopback") {
    const configuredOrigin = env.SPARK_HUB_PUBLIC_URL?.trim() || env.ORIGIN?.trim() || "auto";
    const origin = configuredOrigin === "auto" ? url : new URL(configuredOrigin);
    const hops = Number(env.SPARK_HUB_PROXY_HOPS?.trim() || "1");
    if (!Number.isSafeInteger(hops) || hops < 1 || hops > 10) {
      throw new Error("SPARK_HUB_PROXY_HOPS must be an integer between 1 and 10.");
    }

    headers.host = origin.host;
    headers["x-forwarded-for"] = Array(hops).fill(loopbackAddress).join(", ");
    headers["x-forwarded-proto"] = origin.protocol.slice(0, -1);
  }

  return { url, headers };
}

export async function checkHubHealth(env = process.env, fetcher = fetch) {
  const { url, headers } = createHubHealthcheckRequest(env);
  const response = await fetcher(url, { headers });
  if (!response.ok) return false;

  const body = await response.json();
  return body?.service === "spark-hub" && body.status === "ok";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!(await checkHubHealth())) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
