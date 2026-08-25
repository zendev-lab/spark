import assert from "node:assert/strict";
import { test } from "vitest";

import {
  isSparkWebHtmlNavigation,
  isSparkWebLoopbackClientAddress,
  renderSparkWebAccessPage,
  sanitizeSparkWebReturnTo,
  SPARK_WEB_ACCESS_PATH,
} from "./web-access.ts";

test("loopback client classification handles IPv4, IPv6, and mapped IPv4", () => {
  for (const address of ["127.0.0.1", "127.42.0.9", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
    assert.equal(isSparkWebLoopbackClientAddress(address), true, address);
  }
  for (const address of [undefined, null, "10.0.0.2", "::ffff:10.0.0.2"]) {
    assert.equal(isSparkWebLoopbackClientAddress(address), false, String(address));
  }
});

test("access return paths stay same-origin", () => {
  assert.equal(sanitizeSparkWebReturnTo("/sessions/sess_1?tab=work"), "/sessions/sess_1?tab=work");
  assert.equal(sanitizeSparkWebReturnTo("https://evil.example/"), "/");
  assert.equal(sanitizeSparkWebReturnTo("//evil.example/"), "/");
  assert.equal(sanitizeSparkWebReturnTo(undefined), "/");
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
