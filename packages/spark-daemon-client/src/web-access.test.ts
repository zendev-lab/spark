import assert from "node:assert/strict";
import { isIPv4 } from "node:net";
import { test } from "vitest";

import {
  isSparkWebHtmlNavigation,
  isSparkWebLoopbackClientAddress,
  renderSparkWebAccessPage,
  resolveSparkWebAccessChallenge,
  resolveSparkWebAccessRequest,
  resolveSparkWebLanAddresses,
  sanitizeSparkWebReturnTo,
  SPARK_WEB_ACCESS_PATH,
  sparkWebAccessSetCookie,
  sparkWebRequestReturnTo,
  sparkWebTokenFromCarriers,
} from "./web-access.ts";

test("loopback client classification handles IPv4, IPv6, and mapped IPv4", () => {
  for (const address of [
    "127.0.0.1",
    "127.42.0.9",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:127.42.0.9",
    "localhost",
    "LOCALHOST",
    "::1%lo0",
  ]) {
    assert.equal(isSparkWebLoopbackClientAddress(address), true, address);
  }
  for (const address of [
    undefined,
    null,
    "",
    "10.0.0.2",
    "0.0.0.0",
    "spark.lan",
    "::ffff:10.0.0.2",
    "127.999.1.1",
    "127.1",
  ]) {
    assert.equal(isSparkWebLoopbackClientAddress(address), false, String(address));
  }
});

test("LAN discovery returns local IPv4 literals, never loopback", () => {
  for (const address of resolveSparkWebLanAddresses()) {
    assert.equal(isIPv4(address), true, address);
    assert.equal(address.startsWith("127."), false, address);
  }
});

test("access return paths stay same-origin", () => {
  assert.equal(sanitizeSparkWebReturnTo("/sessions/sess_1?tab=work"), "/sessions/sess_1?tab=work");
  assert.equal(sanitizeSparkWebReturnTo("https://evil.example/"), "/");
  assert.equal(sanitizeSparkWebReturnTo("//evil.example/"), "/");
  assert.equal(sanitizeSparkWebReturnTo(undefined), "/");
  assert.equal(
    sparkWebRequestReturnTo(new URL("http://10.0.0.2:4310/sessions/sess_1?token=sdu_x&tab=work")),
    "/sessions/sess_1?tab=work",
  );
});

test("token carriers prefer query, then header, then cookie", () => {
  assert.equal(sparkWebTokenFromCarriers({ query: "q", cookie: "c" }), "q");
  assert.equal(sparkWebTokenFromCarriers({ header: "h", cookie: "c" }), "h");
  assert.equal(sparkWebTokenFromCarriers({ cookie: "c" }), "c");
  assert.equal(sparkWebTokenFromCarriers({}), null);
});

test("access cookie is HttpOnly and SameSite=Strict", () => {
  assert.equal(
    sparkWebAccessSetCookie("sdu_good"),
    "spark_web_token=sdu_good; Path=/; HttpOnly; SameSite=Strict",
  );
  assert.match(sparkWebAccessSetCookie("sdu_good", true), /; Secure$/u);
});

test("access form GET and POST share one state machine", async () => {
  const verify = async (token: string) =>
    token === "sdu_good" ? "valid" : token === "sdu_down" ? "unavailable" : "invalid";

  assert.deepEqual(
    await resolveSparkWebAccessRequest({
      method: "GET",
      tokenRequired: false,
      returnTo: "/sessions/sess_1",
      verify,
    }),
    { type: "redirect", location: "/sessions/sess_1" },
  );
  assert.deepEqual(
    await resolveSparkWebAccessRequest({
      method: "HEAD",
      tokenRequired: true,
      returnTo: "/sessions/sess_1",
      verify,
    }),
    { type: "page", status: 200, state: "prompt", returnTo: "/sessions/sess_1" },
  );
  assert.deepEqual(
    await resolveSparkWebAccessRequest({
      method: "POST",
      tokenRequired: true,
      returnTo: "/sessions/sess_1",
      token: "sdu_good",
      verify,
    }),
    { type: "redirect", location: "/sessions/sess_1", token: "sdu_good" },
  );
  assert.deepEqual(
    await resolveSparkWebAccessRequest({
      method: "POST",
      tokenRequired: true,
      returnTo: "/",
      token: "sdu_bad",
      verify,
    }),
    { type: "page", status: 401, state: "invalid", returnTo: "/" },
  );
  assert.deepEqual(
    await resolveSparkWebAccessRequest({
      method: "POST",
      tokenRequired: true,
      returnTo: "/",
      token: "sdu_down",
      verify,
    }),
    { type: "page", status: 503, state: "unavailable", returnTo: "/" },
  );
  assert.deepEqual(
    await resolveSparkWebAccessRequest({
      method: "PUT",
      tokenRequired: true,
      verify,
    }),
    { type: "methodNotAllowed" },
  );
});

test("unauthenticated HTML navigations get the access page; APIs keep carriers", () => {
  assert.deepEqual(resolveSparkWebAccessChallenge({ htmlNavigation: true, reason: "missing" }), {
    type: "page",
    status: 200,
    state: "prompt",
  });
  assert.deepEqual(resolveSparkWebAccessChallenge({ htmlNavigation: true, reason: "invalid" }), {
    type: "page",
    status: 401,
    state: "invalid",
  });
  assert.deepEqual(
    resolveSparkWebAccessChallenge({ htmlNavigation: true, reason: "unavailable" }),
    { type: "page", status: 503, state: "unavailable" },
  );
  assert.deepEqual(resolveSparkWebAccessChallenge({ htmlNavigation: false, reason: "missing" }), {
    type: "carrier",
    status: 401,
  });
  assert.deepEqual(
    resolveSparkWebAccessChallenge({ htmlNavigation: false, reason: "unavailable" }),
    { type: "carrier", status: 503 },
  );
});

test("access page is framework-neutral and escapes dynamic values", () => {
  const html = renderSparkWebAccessPage({
    state: "invalid",
    returnTo: "/?q=<script>",
    product: '<Spark & "DSH">',
  });
  assert.match(html, new RegExp(`action="${SPARK_WEB_ACCESS_PATH}"`, "u"));
  assert.match(html, /Invalid access token/u);
  assert.match(html, /spark daemon access create/u);
  assert.doesNotMatch(html, /<script>/u);
  assert.match(html, /&lt;Spark &amp; &quot;DSH&quot;&gt;/u);
});

test("only GET and HEAD HTML requests are access-page navigations", () => {
  assert.equal(isSparkWebHtmlNavigation({ method: "GET", accept: "text/html" }), true);
  assert.equal(isSparkWebHtmlNavigation({ method: "HEAD", accept: "text/html, */*" }), true);
  assert.equal(isSparkWebHtmlNavigation({ method: "POST", accept: "text/html" }), false);
  assert.equal(isSparkWebHtmlNavigation({ method: "GET", accept: "application/json" }), false);
});
