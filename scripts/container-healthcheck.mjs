import { pathToFileURL } from "node:url";

const loopbackAddress = "127.0.0.1";

export function createHubHealthcheckRequest(env = process.env) {
  const port = env.PORT?.trim() || "5173";
  const url = new URL(`http://${loopbackAddress}:${port}/api/v1/health`);
  const headers = {};

  const trustProxy = renamedEnv(env, "SPARK_HUB_TRUST_PROXY", "SPARK_COCKPIT_TRUST_PROXY");
  if (trustProxy === "loopback") {
    const configuredOrigin =
      renamedEnv(env, "SPARK_HUB_PUBLIC_URL", "SPARK_COCKPIT_PUBLIC_URL") ||
      env.ORIGIN?.trim() ||
      "auto";
    const origin = configuredOrigin === "auto" ? url : new URL(configuredOrigin);
    const hops = Number(renamedEnv(env, "SPARK_HUB_PROXY_HOPS", "SPARK_COCKPIT_PROXY_HOPS") || "1");
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

function renamedEnv(env, canonical, legacy) {
  const canonicalValue = env[canonical]?.trim();
  const legacyValue = env[legacy]?.trim();
  if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
    throw new Error(`${canonical} conflicts with retired ${legacy}.`);
  }
  return canonicalValue || legacyValue || undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!(await checkHubHealth())) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
  }
}
