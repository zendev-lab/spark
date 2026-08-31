import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSparkPrivateWebServerClass,
  SPARK_WEB_DSH_PROXY_HEADER,
  takeSparkWebDshProxyCredential,
} from "./private-webserver.ts";

const CREDENTIAL = "private-credential-with-at-least-thirty-two-bytes";

class FakeWebServer {
  httpHandler?: (request: FakeRequest, response: FakeResponse) => unknown;
  upgradeHandler?: (request: FakeRequest, socket: FakeSocket, head: Buffer) => unknown;
  fallbackHandler?: (request: FakeRequest, response: FakeResponse) => unknown;

  register(route: { handler(request: FakeRequest, response: FakeResponse): unknown }): void {
    this.httpHandler = (request, response) => route.handler(request, response);
  }

  registerUpgrade(route: {
    handler(request: FakeRequest, socket: FakeSocket, head: Buffer): unknown;
  }): void {
    this.upgradeHandler = (request, socket, head) => route.handler(request, socket, head);
  }

  registerFallback(handler: (request: FakeRequest, response: FakeResponse) => unknown): void {
    this.fallbackHandler = handler;
  }
}

interface FakeRequest {
  headers: Record<string, string | string[] | undefined>;
}

class FakeResponse {
  headersSent = false;
  status?: number;
  body = "";

  writeHead(status: number): void {
    this.status = status;
    this.headersSent = true;
  }

  end(body = ""): void {
    this.body += body;
  }
}

class FakeSocket {
  output = "";
  ended = false;

  end(chunk = ""): void {
    this.output += chunk;
    this.ended = true;
  }
}

function request(credential?: string): FakeRequest {
  return {
    headers: credential === undefined ? {} : { [SPARK_WEB_DSH_PROXY_HEADER]: credential },
  };
}

test("private proxy credential is read only from the inherited descriptor", () => {
  let seenFd: number | undefined;
  assert.equal(
    takeSparkWebDshProxyCredential(7, (fd) => {
      seenFd = fd;
      return CREDENTIAL;
    }),
    CREDENTIAL,
  );
  assert.equal(seenFd, 7);
  assert.throws(
    () => takeSparkWebDshProxyCredential(7, () => "short"),
    /credential is unavailable/u,
  );
});

test("private WebServer guards HTTP, fallback, and upgrade handlers", async () => {
  const PrivateWebServer = createSparkPrivateWebServerClass(FakeWebServer, CREDENTIAL);
  const server = new PrivateWebServer() as FakeWebServer;
  let httpCalls = 0;
  let fallbackCalls = 0;
  let upgradeCalls = 0;
  server.register({
    handler: () => {
      httpCalls += 1;
    },
  });
  server.registerFallback(() => {
    fallbackCalls += 1;
  });
  server.registerUpgrade({
    handler: () => {
      upgradeCalls += 1;
    },
  });

  for (const invoke of [server.httpHandler, server.fallbackHandler]) {
    assert.ok(invoke !== undefined);
    const missing = new FakeResponse();
    await invoke(request(), missing);
    assert.equal(missing.status, 403);
    assert.match(missing.body, /private server/u);

    const wrong = new FakeResponse();
    await invoke(request(`${CREDENTIAL}-wrong`), wrong);
    assert.equal(wrong.status, 403);

    const accepted = new FakeResponse();
    await invoke(request(CREDENTIAL), accepted);
    assert.equal(accepted.status, undefined);
  }

  assert.ok(server.upgradeHandler !== undefined);
  const rejectedSocket = new FakeSocket();
  await server.upgradeHandler(request(), rejectedSocket, Buffer.alloc(0));
  assert.match(rejectedSocket.output, /403 Forbidden/u);
  assert.equal(rejectedSocket.ended, true);

  const acceptedSocket = new FakeSocket();
  await server.upgradeHandler(request(CREDENTIAL), acceptedSocket, Buffer.alloc(0));
  assert.equal(acceptedSocket.ended, false);
  assert.equal(httpCalls, 1);
  assert.equal(fallbackCalls, 1);
  assert.equal(upgradeCalls, 1);
});
