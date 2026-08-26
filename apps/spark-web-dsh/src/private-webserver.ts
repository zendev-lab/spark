import { timingSafeEqual } from "node:crypto";

export const SPARK_WEB_DSH_PROXY_HEADER = "x-spark-web-dsh-proxy";
export const SPARK_WEB_DSH_PROXY_CREDENTIAL_KEY =
  "@zendev-lab/spark-web-dsh/private-proxy-credential";

interface SparkPrivateHttpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface SparkPrivateHttpResponse {
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string>): unknown;
  end(body?: string): unknown;
}

interface SparkPrivateSocket {
  end(chunk?: string): unknown;
}

interface SparkPrivateHttpRoute {
  kind: string;
  path: string;
  handler(request: SparkPrivateHttpRequest, response: SparkPrivateHttpResponse): unknown;
}

interface SparkPrivateUpgradeRoute {
  path: string;
  handler(request: SparkPrivateHttpRequest, socket: SparkPrivateSocket, head: Buffer): unknown;
}

interface SparkPrivateWebServer {
  register(route: SparkPrivateHttpRoute): unknown;
  registerUpgrade(route: SparkPrivateUpgradeRoute): unknown;
  registerFallback(handler: SparkPrivateHttpRoute["handler"]): unknown;
}

type SparkPrivateWebServerConstructor = new (...args: never[]) => SparkPrivateWebServer;

/** Consume the boot-pipe credential once; later plugins and subprocesses cannot recover it. */
export function takeSparkWebDshProxyCredential(): string {
  const key = Symbol.for(SPARK_WEB_DSH_PROXY_CREDENTIAL_KEY);
  const credential = Reflect.get(globalThis, key);
  Reflect.deleteProperty(globalThis, key);
  if (typeof credential !== "string" || credential.length < 32) {
    throw new Error("spark web-dsh: private proxy credential is unavailable");
  }
  return credential;
}

/**
 * Decorate DSH's public WebServer registration API so every HTTP, fallback,
 * and upgrade handler requires the per-process credential injected by Spark's
 * outer proxy. The upstream server implementation remains otherwise intact.
 */
export function createSparkPrivateWebServerClass(
  Base: SparkPrivateWebServerConstructor,
  credential: string,
): SparkPrivateWebServerConstructor {
  const expected = Buffer.from(credential);
  const authorized = (request: SparkPrivateHttpRequest): boolean => {
    const presented = request.headers[SPARK_WEB_DSH_PROXY_HEADER];
    if (typeof presented !== "string") return false;
    const actual = Buffer.from(presented);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  return class SparkPrivateWebServer extends Base {
    override register(route: SparkPrivateHttpRoute): unknown {
      return super.register({
        ...route,
        handler: (request, response) => {
          if (!authorized(request)) return rejectHttp(response);
          return route.handler(request, response);
        },
      });
    }

    override registerUpgrade(route: SparkPrivateUpgradeRoute): unknown {
      return super.registerUpgrade({
        ...route,
        handler: (request, socket, head) => {
          if (!authorized(request)) return rejectUpgrade(socket);
          return route.handler(request, socket, head);
        },
      });
    }

    override registerFallback(handler: SparkPrivateHttpRoute["handler"]): unknown {
      return super.registerFallback((request, response) => {
        if (!authorized(request)) return rejectHttp(response);
        return handler(request, response);
      });
    }
  };
}

function rejectHttp(response: SparkPrivateHttpResponse): void {
  if (!response.headersSent) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  }
  response.end("spark web-dsh private server\n");
}

function rejectUpgrade(socket: SparkPrivateSocket): void {
  socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
}
