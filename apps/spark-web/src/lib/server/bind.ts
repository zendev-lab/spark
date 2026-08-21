export const SPARK_WEB_DEFAULT_HOST = "127.0.0.1";
export const SPARK_WEB_DEFAULT_PORT = 4310;

export function isSparkWebLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
  );
}

export function normalizeSparkWebTrustedHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || /[/?#@]/u.test(trimmed) || trimmed.includes("*")) {
    throw new Error(
      `spark web --trusted-host requires a hostname or host:port, got ${JSON.stringify(value)}`,
    );
  }
  let url: URL;
  try {
    url = new URL(`http://${trimmed}`);
  } catch {
    throw new Error(`spark web --trusted-host is invalid: ${JSON.stringify(value)}`);
  }
  if (!url.hostname || url.username || url.password || url.pathname !== "/") {
    throw new Error(`spark web --trusted-host is invalid: ${JSON.stringify(value)}`);
  }
  return url.host;
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

export function parseSparkWebBindArgs(argv: readonly string[]): {
  host: string;
  port: number;
  open: boolean;
  trustedHosts: string[];
  argv: string[];
} {
  let host = SPARK_WEB_DEFAULT_HOST;
  let port = SPARK_WEB_DEFAULT_PORT;
  let open = true;
  const trustedHosts: string[] = [];
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
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--trusted-host") {
      const value = argv[++index];
      if (value === undefined) throw new Error("spark web --trusted-host requires a value");
      trustedHosts.push(normalizeSparkWebTrustedHost(value));
      continue;
    }
    if (arg.startsWith("--trusted-host=")) {
      trustedHosts.push(normalizeSparkWebTrustedHost(arg.slice("--trusted-host=".length)));
      continue;
    }
    rest.push(arg);
  }
  if (!host.trim()) throw new Error("spark web --host requires a non-empty value");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`spark web --port must be between 1 and 65535, got ${port}`);
  }
  const uniqueTrustedHosts = [...new Set(trustedHosts)];
  if (!isSparkWebLoopbackHost(host) && uniqueTrustedHosts.length === 0) {
    throw new Error("spark web requires --trusted-host when --host is not loopback");
  }
  return { host, port, open, trustedHosts: uniqueTrustedHosts, argv: rest };
}
