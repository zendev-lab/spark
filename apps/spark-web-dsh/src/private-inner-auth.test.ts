import assert from "node:assert/strict";
import { test } from "vitest";

import { mintSparkWebDshInnerCookie, publishSparkWebDshInnerCookie } from "./private-inner-auth.ts";

const COOKIE = "dsh-auth-authority=v1.body.signature";

function connection(setCookie = `${COOKIE}; Max-Age=60; Path=/; HttpOnly`) {
  return {
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl);
      url.searchParams.set("token", "inner-launch-token");
      return url.href;
    },
    authorizeIndex(
      request: { method: string; url: string; headers: Record<string, string> },
      response: {
        writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
        end(): unknown;
      },
    ) {
      assert.equal(request.method, "GET");
      assert.equal(request.headers.host, "127.0.0.1:51234");
      assert.equal(request.url, "/?token=inner-launch-token");
      response.writeHead(303, { location: "/", "set-cookie": setCookie });
      response.end();
      return false;
    },
  };
}

test("inner auth mints only the DSH cookie pair from public Connection methods", () => {
  assert.equal(mintSparkWebDshInnerCookie(connection(), 51234), COOKIE);
});

test("inner auth publishes the cookie through fd 4 and closes the pipe", () => {
  const writes: Array<[number, string]> = [];
  const closes: number[] = [];
  publishSparkWebDshInnerCookie(
    { connection: connection(), webServer: { port: 51234 } },
    4,
    (fd, value) => writes.push([fd, value]),
    (fd) => closes.push(fd),
  );
  assert.deepEqual(writes, [[4, `${COOKIE}\n`]]);
  assert.deepEqual(closes, [4]);
});

test("inner auth rejects malformed DSH cookies", () => {
  assert.throws(
    () => mintSparkWebDshInnerCookie(connection("spark_web_token=leak; Path=/"), 51234),
    /invalid session cookie/u,
  );
});
