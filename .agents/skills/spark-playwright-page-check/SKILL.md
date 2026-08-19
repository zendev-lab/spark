---
name: spark-playwright-page-check
description: Use when a running Spark or DSH web service needs real-browser verification — page load, client-plugin boot errors, console errors, failed requests, or onboarding/dialog rendering — with the repository's own Playwright chromium.
---

# Spark Playwright page check

Verify a live web page in a real Chromium using the repository's existing
Playwright installation. This is the evidence-generating counterpart to a
`curl` smoke test: it captures browser console errors, page exceptions, and
failed network requests that curl cannot see (client-plugin loader failures
such as `invalid plugin ... received undefined` surface here only).

## Prerequisites

- The target service is already running (e.g. `spark web --port 3987` booted the DSH web profile).
- Playwright chromium binaries are installed: `ls ~/Library/Caches/ms-playwright/` (macOS) or run `pnpm --filter @zendev-lab/spark-hub run setup:browser` once.
- Run the script from inside `apps/spark-hub` so the `playwright` package resolves.

## Procedure

1. Create a temporary script next to the hub package (must live under the repo so ESM resolves `playwright`), e.g. `apps/spark-hub/.page-check.mjs`:

```js
// Real-browser page check: console errors, page errors, failed requests, body evidence.
import { chromium } from "playwright";

const url = process.argv[2] ?? "http://127.0.0.1:3987/";
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
page.on("pageerror", (err) => pageErrors.push(String(err)));
page.on("requestfailed", (req) => failedRequests.push(`${req.url()} :: ${req.failure()?.errorText ?? "?"}`));

const response = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
console.log("PAGE_STATUS:", response?.status());
await page.waitForTimeout(6000); // let client plugins boot

const bodyText = (await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")).slice(0, 1200);
console.log("BODY_SNIPPET:", JSON.stringify(bodyText.slice(0, 600)));
console.log("CONSOLE_ERRORS:", JSON.stringify(consoleErrors.slice(0, 8), null, 2));
console.log("PAGE_ERRORS:", JSON.stringify(pageErrors.slice(0, 4), null, 2));
console.log("FAILED_REQUESTS:", JSON.stringify(failedRequests.slice(0, 8), null, 2));
await page.screenshot({ path: "/tmp/spark-web-shot.png" });
console.log("SCREENSHOT: /tmp/spark-web-shot.png");

await browser.close();
```

2. Run it from the package directory:

   ```sh
   cd apps/spark-hub && node .page-check.mjs "http://127.0.0.1:3987/"
   ```

3. Read the verdict:

   | Signal | Meaning |
   | --- | --- |
   | `PAGE_STATUS: 200` | Server answered (also checkable via curl) |
   | `CONSOLE_ERRORS: []` | No browser-side errors — client plugins booted cleanly |
   | `PAGE_ERRORS: []` | No uncaught page exceptions |
   | `FAILED_REQUESTS: []` | No fetch/asset failures (plugins, events, api) |
   | `BODY_SNIPPET` | Evidence the app rendered expected UI (sessions, settings, onboarding markers) |

4. Clean up the temporary script afterwards; never commit it.

## Evidence rules

- Report `PAGE_STATUS`, `CONSOLE_ERRORS`, `PAGE_ERRORS`, `FAILED_REQUESTS`, and the body snippet verbatim.
- Do not claim "page works" from a 200 alone — a 200 page can still fail client-plugin boot (loader errors only appear in `CONSOLE_ERRORS`/`PAGE_ERRORS`).
- Do not read screenshots as evidence unless the model can view images; the structured fields above are the evidence.
- The URL is not trusted on the service side: a browser check does not replace `--trusted-host` setup for real LAN access from other machines.

Return `pageStatus`, `consoleErrors`, `pageErrors`, `failedRequests`, `bodyEvidence`, `verdict`, and `blockingReasons`.
