export const SPARK_WEB_DEFAULT_HOST = "127.0.0.1";
export const SPARK_WEB_DEFAULT_PORT = 4310;

export function parseSparkWebBindArgs(argv: readonly string[]): {
  host: string;
  port: number;
  open: boolean;
  argv: string[];
} {
  let host = SPARK_WEB_DEFAULT_HOST;
  let port = SPARK_WEB_DEFAULT_PORT;
  let open = true;
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
    rest.push(arg);
  }
  return { host, port, open, argv: rest };
}
