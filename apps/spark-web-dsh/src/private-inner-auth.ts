import { closeSync, writeFileSync } from "node:fs";

interface InnerAuthRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface InnerAuthResponse {
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
  end(): unknown;
}

interface InnerConnection {
  authenticatedUrl(baseUrl: string): string;
  authorizeIndex(request: InnerAuthRequest, response: InnerAuthResponse): boolean;
}

interface InnerAuthContext {
  connection: InnerConnection;
  webServer: { port: number };
}

export const name = "spark-private-inner-auth";
export const inject = ["connection", "webServer"] as const;

/**
 * Mint one authority-bound DSH browser cookie without exposing its launch
 * token in argv, the environment, process output, or a browser-visible URL.
 */
export function mintSparkWebDshInnerCookie(connection: InnerConnection, port: number): string {
  const origin = `http://127.0.0.1:${String(port)}`;
  const authenticated = new URL(connection.authenticatedUrl(origin));
  let status: number | undefined;
  let setCookie: string | undefined;
  const served = connection.authorizeIndex(
    {
      method: "GET",
      url: `${authenticated.pathname}${authenticated.search}`,
      headers: { host: authenticated.host },
    },
    {
      writeHead(nextStatus, headers) {
        status = nextStatus;
        const value = headers?.["set-cookie"];
        setCookie = Array.isArray(value) ? value[0] : value;
      },
      end() {},
    },
  );
  if (served || status !== 303 || setCookie === undefined) {
    throw new Error("spark web-dsh: DSH inner authentication did not mint a session cookie");
  }
  const cookie = setCookie.split(";", 1)[0]?.trim();
  if (
    cookie === undefined ||
    cookie.length > 4096 ||
    !/^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._-]+$/u.test(cookie)
  ) {
    throw new Error("spark web-dsh: DSH inner authentication returned an invalid session cookie");
  }
  return cookie;
}

/** Send the inner-only cookie to Spark's parent proxy through inherited fd 4. */
export function publishSparkWebDshInnerCookie(
  ctx: InnerAuthContext,
  fd = 4,
  write = (target: number, value: string) => writeFileSync(target, value, "utf8"),
  close = (target: number) => closeSync(target),
): void {
  const cookie = mintSparkWebDshInnerCookie(ctx.connection, ctx.webServer.port);
  write(fd, `${cookie}\n`);
  close(fd);
}

export function apply(ctx: InnerAuthContext): void {
  publishSparkWebDshInnerCookie(ctx);
}
