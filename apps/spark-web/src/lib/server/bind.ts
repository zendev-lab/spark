import {
  isSparkWebLoopbackClientAddress,
  resolveSparkWebLanAddresses,
} from "@zendev-lab/spark-daemon-client";

export { resolveSparkWebLanAddresses };

export const SPARK_WEB_DEFAULT_HOST = "127.0.0.1";
export const SPARK_WEB_DEFAULT_PORT = 4310;
export const SPARK_WEB_ALL_INTERFACES_HOST = "0.0.0.0";

export function isSparkWebLoopbackHost(host: string): boolean {
  return isSparkWebLoopbackClientAddress(host);
}

export function sparkWebBrowserAuthority(host: string, port: number): string {
  const trimmed = host.trim();
  let parsed: URL;
  try {
    parsed = new URL(`http://${trimmed}`);
  } catch {
    parsed = new URL(`http://[${trimmed}]`);
  }
  const hostname =
    parsed.hostname.startsWith("[") || !parsed.hostname.includes(":")
      ? parsed.hostname
      : `[${parsed.hostname}]`;
  return parsed.port ? parsed.host : `${hostname}:${port}`;
}

export function sparkWebReachableHosts(host: string): string[] {
  if (isSparkWebLoopbackHost(host)) return [host];
  if (host.trim() === SPARK_WEB_ALL_INTERFACES_HOST) {
    return ["127.0.0.1", ...resolveSparkWebLanAddresses()];
  }
  return [host];
}

export function parseSparkWebBindArgs(argv: readonly string[]): {
  host: string;
  port: number;
  hmr: boolean;
  argv: string[];
} {
  let host = SPARK_WEB_DEFAULT_HOST;
  let port = SPARK_WEB_DEFAULT_PORT;
  let hmr = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--host") {
      const value = argv[++index];
      if (value === undefined) throw new Error("spark web --host requires a value");
      host = value;
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--port") {
      const raw = argv[++index];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error(`spark web --port must be a number, got ${JSON.stringify(raw)}`);
      }
      port = Number(raw);
      continue;
    }
    if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      if (!/^\d+$/.test(raw)) {
        throw new Error(`spark web --port must be a number, got ${JSON.stringify(raw)}`);
      }
      port = Number(raw);
      continue;
    }
    if (arg === "--hmr") {
      hmr = true;
      continue;
    }
    if (arg === "--no-open") {
      // Keep accepting the former opt-out after browser launch became disabled globally.
      continue;
    }
    if (arg === "--trusted-host" || arg.startsWith("--trusted-host=")) {
      throw new Error(
        "spark web no longer supports --trusted-host; local interface addresses are trusted automatically",
      );
    }
    rest.push(arg);
  }
  if (!host.trim()) throw new Error("spark web --host requires a non-empty value");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`spark web --port must be between 1 and 65535, got ${port}`);
  }
  return { host, port, hmr, argv: rest };
}
