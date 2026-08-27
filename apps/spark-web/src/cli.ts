import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSparkWebStartupAccessToken,
  ensureSparkDaemonRunning,
  SparkDaemonStartupError,
  type SparkWebStartupAccessToken,
} from "@zendev-lab/spark-daemon-client";
import { formatSparkCliError, SparkCliError, sparkCliExitCode } from "@zendev-lab/spark-i18n/cli";

import { SPARK_WEB_BIND_HOST_ENV, SPARK_WEB_BIND_PORT_ENV } from "./lib/server/auth.ts";
import {
  parseSparkWebBindArgs,
  sparkWebBrowserAuthority,
  sparkWebReachableHosts,
} from "./lib/server/bind.ts";
import {
  attachSparkWebLease,
  heartbeatSparkWebLease,
  releaseSparkWebLease,
} from "./lib/server/lease.ts";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPARK_WEB_PROTOCOL_HEADER = "x-spark-web-proto";

export interface SparkWebDevelopmentServerOptions {
  appDir: string;
  host: string;
  port: number;
  hmr: boolean;
}

export interface SparkWebCliOptions {
  startDevelopmentServer?: (options: SparkWebDevelopmentServerOptions) => Promise<void>;
  ensureDaemonRunning?: typeof ensureSparkDaemonRunning;
}

export async function runSparkWebCli(
  argv: string[] = process.argv.slice(2),
  options: SparkWebCliOptions = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(sparkWebHelpText());
    return 0;
  }

  let bind: ReturnType<typeof parseSparkWebBindArgs>;
  try {
    bind = parseSparkWebBindArgs(argv);
  } catch (error) {
    throw new SparkCliError(
      {
        code: "INVALID_ARGUMENT",
        title: "Invalid spark web options",
        description: errorMessage(error),
        hints: ['Run "spark web --help" to see the supported options.'],
        exitCode: 2,
      },
      { cause: error },
    );
  }
  process.env[SPARK_WEB_BIND_HOST_ENV] = bind.host;
  process.env[SPARK_WEB_BIND_PORT_ENV] = String(bind.port);

  try {
    await (options.ensureDaemonRunning ?? ensureSparkDaemonRunning)();
  } catch (error) {
    throw sparkWebDaemonError(error);
  }
  const lease = await attachSparkWebLease({ localPath: process.cwd() });
  const heartbeat = setInterval(() => {
    if (!lease) return;
    void heartbeatSparkWebLease(lease).catch(() => undefined);
  }, 15_000);
  heartbeat.unref();
  let startupAccess: SparkWebStartupAccessToken | undefined;
  const stop = async () => {
    clearInterval(heartbeat);
    await Promise.all([
      lease ? releaseSparkWebLease(lease).catch(() => undefined) : Promise.resolve(),
      revokeStartupAccess(startupAccess),
    ]);
  };
  const interrupt = () => {
    void stop().then(() => process.exit(0));
  };
  const terminate = () => {
    void stop().then(() => process.exit(0));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);

  try {
    startupAccess = await createSparkWebStartupAccessToken("spark web");

    const handlerPath = join(appDir, "build", "handler.js");
    if (!bind.hmr && existsSync(handlerPath)) {
      configureSparkWebPlainHttpProtocol();
      const { handler } = (await import(handlerPath)) as {
        handler: (
          request: import("node:http").IncomingMessage,
          response: import("node:http").ServerResponse,
        ) => void;
      };
      await new Promise<void>((resolveListen, reject) => {
        const server = createServer((request, response) => {
          markSparkWebPlainHttpRequest(request);
          handler(request, response);
        });
        server.on("error", (error) => reject(sparkWebListenError(error, bind)));
        server.listen(bind.port, bind.host, () => resolveListen());
      });
    } else if (options.startDevelopmentServer) {
      await options.startDevelopmentServer({
        appDir,
        host: bind.host,
        port: bind.port,
        hmr: bind.hmr,
      });
    } else {
      throw new SparkCliError({
        code: "WEB_BUILD_MISSING",
        title: "Spark web build is missing",
        description: `The server handler was not found at ${handlerPath}.`,
        hints: ["Build the Spark web app through its package script, then retry."],
      });
    }
  } catch (error) {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    await stop();
    throw error;
  }

  const urls = sparkWebBrowserUrls(bind);
  process.stdout.write(sparkWebListeningText(urls, startupAccess.token));
  return await new Promise<number>(() => undefined);
}

async function revokeStartupAccess(access: SparkWebStartupAccessToken | undefined): Promise<void> {
  if (!access) return;
  try {
    await access.revoke();
  } catch (error) {
    process.stderr.write(
      `spark web: could not revoke startup access token ${access.recordId}; ` +
        `run "spark daemon access revoke ${access.recordId}". ${errorMessage(error)}\n`,
    );
  }
}

/** Adapter Node otherwise assumes HTTPS when its handler is embedded directly. */
export function configureSparkWebPlainHttpProtocol(env = process.env): void {
  env.PROTOCOL_HEADER = SPARK_WEB_PROTOCOL_HEADER;
}

/** Never trust a client-supplied forwarding header for the direct HTTP listener. */
export function markSparkWebPlainHttpRequest(request: {
  headers: Record<string, string | string[] | undefined>;
}): void {
  request.headers[SPARK_WEB_PROTOCOL_HEADER] = "http";
}

export function sparkWebListeningText(urls: readonly string[], accessToken: string): string {
  return (
    `Spark web listening:\n${urls.map((url) => `  ${url}`).join("\n")}\n` +
    `Startup access token:\n  ${accessToken}\nSpark revokes this token during normal shutdown.\n`
  );
}

export function sparkWebBrowserUrls(
  bind: Pick<ReturnType<typeof parseSparkWebBindArgs>, "host" | "port">,
): string[] {
  return sparkWebReachableHosts(bind.host).map(
    (host) => `http://${sparkWebBrowserAuthority(host, bind.port)}/`,
  );
}

export function sparkWebBrowserUrl(
  bind: Pick<ReturnType<typeof parseSparkWebBindArgs>, "host" | "port">,
): string {
  return sparkWebBrowserUrls(bind)[0]!;
}

export function runSparkWebProcess(options: SparkWebCliOptions = {}): void {
  runSparkWebCli(process.argv.slice(2), options)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        formatSparkCliError(error, {
          code: "WEB_START_FAILED",
          title: "Spark web could not start",
        }),
      );
      process.exitCode = sparkCliExitCode(error);
    });
}

function sparkWebDaemonError(error: unknown): SparkCliError {
  if (error instanceof SparkDaemonStartupError) {
    return new SparkCliError(
      {
        code: error.code,
        title: "Spark daemon failed to start",
        description: "Spark web started the daemon service, but it did not become ready.",
        hints: [
          'Run "spark doctor" to check the daemon installation and state.',
          'Run "spark daemon logs --lines 100" to inspect the startup log.',
        ],
        detail: error.diagnostic,
      },
      { cause: error },
    );
  }
  return new SparkCliError(
    {
      code: "DAEMON_UNAVAILABLE",
      title: "Spark daemon is unavailable",
      description: "Spark web needs the local daemon before it can open the workbench.",
      hints: ['Run "spark daemon start", then retry "spark web".'],
      detail: errorMessage(error),
    },
    { cause: error },
  );
}

function sparkWebListenError(error: unknown, bind: { host: string; port: number }): SparkCliError {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "EADDRINUSE") {
    return new SparkCliError(
      {
        code: "WEB_PORT_IN_USE",
        title: `Spark web could not bind to ${bind.host}:${bind.port}`,
        description: "The address is already in use.",
        hints: [`Choose another port, for example "spark web --port ${bind.port + 1}".`],
        detail: errorMessage(error),
      },
      { cause: error },
    );
  }
  return new SparkCliError(
    {
      code: "WEB_LISTEN_FAILED",
      title: `Spark web could not bind to ${bind.host}:${bind.port}`,
      detail: errorMessage(error),
    },
    { cause: error },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sparkWebHelpText(): string {
  return `spark-web - local Spark daemon workbench

Usage:
  spark-web [--host 127.0.0.1] [--port 4310] [--hmr]

Binds to 127.0.0.1 by default. Binding 0.0.0.0 exposes the workbench on this
host's local IPv4 interfaces automatically; no trusted-host configuration is
needed. Every normal request requires a daemon access token, including requests
from an actual loopback peer. Every startup prints a usable token after the
listener is ready. Manually managed tokens remain available through
spark daemon access create. Host, same-origin
metadata, and mutation provenance are still checked for every bind. Prints the
reachable workbench URLs without opening a browser.
Pass --hmr to use the Vite development server;
the default serves the prebuilt handler without HMR for long-lived use.
Opens on the daemon-wide Session and Invocation view. Workspace remains
repository, cwd, and Artifact context rather than a navigation prerequisite.
Hub remains the multi-daemon proxy and management plane.
`;
}
