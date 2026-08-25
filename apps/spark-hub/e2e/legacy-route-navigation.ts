/// <reference types="node" />

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createHubAccessToken } from "@zendev-lab/spark-hub-coordination/hub-access";
import { defaultDatabasePath, migrate, openDatabase } from "@zendev-lab/spark-hub-storage-sqlite";
import {
  chromium,
  request,
  type APIRequestContext,
  type ConsoleMessage,
  type Page,
} from "playwright";

const host = "127.0.0.1";
const workspaceId = "ws_e2e_route_proof";
const workspaceSlug = "route-proof";
const sessionId = "runtime/ops";
const now = "2026-07-30T00:00:00.000Z";
const maxDiagnosticBytes = 16_384;

const root = await mkdtemp(join(tmpdir(), "spark-hub-route-e2e-"));
let server: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let api: APIRequestContext | undefined;
const browserErrors: string[] = [];
const serverOutput = { stdout: "", stderr: "" };

try {
  const databasePath = withIsolatedEnvironment(root, () => defaultDatabasePath());
  const db = openDatabase({ path: databasePath });
  seedDatabase(db);
  db.close();

  const port = await freePort();
  server = spawn("vp", ["dev", "--host", host, "--port", String(port)], {
    detached: true,
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, HOST: host, PORT: String(port), SPARK_HOME: root, HOME: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureServerOutput(server, serverOutput);

  const baseUrl = `http://${host}:${port}`;
  await waitForHttp(`${baseUrl}/login`, server, serverOutput);
  api = await request.newContext();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  attachBrowserErrors(page, browserErrors);

  const list = await navigate(page, api, `${baseUrl}/sessions?workspace=${workspaceSlug}`);
  assertEqual(list.status, 200, "legacy list response status");
  assertEqual(
    list.finalUrl,
    `${baseUrl}/${workspaceSlug}/sessions/${encodeURIComponent(sessionId)}`,
    "legacy list final URL",
  );

  const detail = await navigate(
    page,
    api,
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}?tab=activity`,
  );
  assertEqual(detail.status, 200, "legacy detail response status");
  assertEqual(
    detail.finalUrl,
    `${baseUrl}/${workspaceSlug}/sessions/${encodeURIComponent(sessionId)}?tab=activity`,
    "legacy detail final URL",
  );

  const rootLogin = await navigate(page, api, `${baseUrl}/login?next=%2Fsettings`);
  assertEqual(rootLogin.status, 200, "root login response status");
  assertEqual(rootLogin.finalUrl, `${baseUrl}/login?next=%2Fsettings`, "root login final URL");
  assertIncludes(await page.locator("body").innerText(), "Hub access", "root login body");

  if (browserErrors.length > 0) {
    throw new Error(`Browser errors:\n${browserErrors.join("\n")}`);
  }
  console.log(
    JSON.stringify({ list, detail, rootLogin, browserErrors: browserErrors.length }, null, 2),
  );
} catch (error) {
  throw withServerDiagnostics(error, server, serverOutput);
} finally {
  await api?.dispose();
  await browser?.close();
  if (server) await stopProcess(server);
  await rm(root, { recursive: true, force: true });
}

function withIsolatedEnvironment<T>(sparkHome: string, operation: () => T): T {
  const previousSparkHome = process.env.SPARK_HOME;
  const previousHome = process.env.HOME;
  process.env.SPARK_HOME = sparkHome;
  process.env.HOME = sparkHome;
  try {
    return operation();
  } finally {
    restoreEnvironment("SPARK_HOME", previousSparkHome);
    restoreEnvironment("HOME", previousHome);
  }
}

function restoreEnvironment(name: "SPARK_HOME" | "HOME", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function seedDatabase(db: DatabaseSync): void {
  migrate(db);
  db.prepare(
    `INSERT INTO workspaces
      (id, slug, name, status, provisioning_state, settings_json, created_at, updated_at)
     VALUES (?, ?, ?, 'active', 'active', '{}', ?, ?)`,
  ).run(workspaceId, workspaceSlug, "Route Proof", now, now);

  const runtimeId = "rt_e2e_route_proof";
  const bindingId = "rtwb_e2e_route_proof";
  db.prepare(
    `INSERT INTO runtime_connections
      (id, installation_id, name, status, protocol_version, capabilities_json, labels_json, created_at, updated_at)
     VALUES (?, 'install-e2e-route-proof', 'E2E runtime', 'online', '1', '{}', '{}', ?, ?)`,
  ).run(runtimeId, now, now);
  createHubAccessToken(db, { daemonIds: [runtimeId], createdAt: now, ttlMs: 3_600_000 });
  db.prepare(
    `INSERT INTO runtime_sessions (id, runtime_id, transport, status, connected_at, last_seen_at)
     VALUES ('rtsn_e2e_route_proof', ?, 'websocket', 'connected', ?, ?)`,
  ).run(runtimeId, now, now);
  db.prepare(
    `INSERT INTO runtime_workspace_bindings
      (id, runtime_id, local_workspace_key, display_name, status, administrator_session_id,
       administrator_provisioning_state, capabilities_json, diagnostics_json, created_at, updated_at)
     VALUES (?, ?, 'route-proof', 'Route Proof', 'available', ?, 'active', '{}', '{}', ?, ?)`,
  ).run(bindingId, runtimeId, sessionId, now, now);
  db.prepare(
    `INSERT INTO workspace_leases
      (id, workspace_id, runtime_workspace_binding_id, owner_mode, started_at, created_at)
     VALUES ('wob_e2e_route_proof', ?, ?, 'primary', ?, ?)`,
  ).run(workspaceId, bindingId, now, now);
  db.prepare(
    `INSERT INTO runtime_session_projections
      (runtime_id, session_id, scope, workspace_id, runtime_workspace_binding_id,
       lifecycle, placement, activity, lifetime, lineage_origin_kind, record_json, projected_at)
     VALUES (?, ?, 'workspace', ?, ?, 'open', 'active', 'idle', 'persistent', 'root', ?, ?)`,
  ).run(
    runtimeId,
    sessionId,
    workspaceId,
    bindingId,
    JSON.stringify({
      sessionId,
      scope: { kind: "workspace", workspaceId },
      name: "Administrator",
      lifecycle: "open",
      placement: "active",
      activity: "idle",
      lifetime: "persistent",
      lineage: { kind: "root" },
      roleBinding: { kind: "explicit", roleRef: "role:builtin-administrator" },
      incarnation: 1,
      visibility: "public",
      retention: "audit",
      purpose: "workspace_administrator",
      bindings: [],
      tags: [],
      archiveHistory: [],
      createdAt: now,
      updatedAt: now,
    }),
    now,
  );
}

interface RedirectHop {
  status: number;
  url: string;
  location: string | null;
}

async function navigate(page: Page, api: APIRequestContext, url: string) {
  const chain = await redirectChain(api, url);
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  return {
    status: response?.status() ?? 0,
    finalUrl: page.url(),
    title: await page.title(),
    redirects: chain,
  };
}

async function redirectChain(api: APIRequestContext, initialUrl: string): Promise<RedirectHop[]> {
  const hops: RedirectHop[] = [];
  let url = initialUrl;
  for (let index = 0; index < 10; index += 1) {
    const response = await api.get(url, { maxRedirects: 0 });
    const location = response.headers().location ?? null;
    hops.push({ status: response.status(), url, location });
    if (!location || response.status() < 300 || response.status() >= 400) return hops;
    url = new URL(location, url).toString();
  }
  throw new Error(`Redirect chain exceeded 10 hops: ${JSON.stringify(hops)}`);
}

function attachBrowserErrors(page: Page, target: string[]): void {
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") target.push(`console.error: ${message.text()}`);
  });
  page.on("pageerror", (error) => target.push(`pageerror: ${error.message}`));
}

async function waitForHttp(
  url: string,
  child: ChildProcess,
  output: { stdout: string; stderr: string },
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    assertServerRunning(child, output);
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for Hub HTTP readiness: ${url}`);
}

function captureServerOutput(
  child: ChildProcess,
  output: { stdout: string; stderr: string },
): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    output.stdout = boundedAppend(output.stdout, text);
    process.stdout.write(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = String(chunk);
    output.stderr = boundedAppend(output.stderr, text);
    process.stderr.write(text);
  });
}

function boundedAppend(current: string, added: string): string {
  return `${current}${added}`.slice(-maxDiagnosticBytes);
}

function assertServerRunning(
  child: ChildProcess,
  output: { stdout: string; stderr: string },
): void {
  if (child.exitCode === null && child.signalCode === null) return;
  throw new Error(
    `Hub server exited before readiness (code=${String(child.exitCode)}, signal=${String(child.signalCode)})\n${renderServerOutput(output)}`,
  );
}

function withServerDiagnostics(
  error: unknown,
  child: ChildProcess | undefined,
  output: { stdout: string; stderr: string },
): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `${message}\nHub server: code=${String(child?.exitCode)}, signal=${String(child?.signalCode)}\n${renderServerOutput(output)}`,
    { cause: error },
  );
}

function renderServerOutput(output: { stdout: string; stderr: string }): string {
  return `--- server stdout ---\n${output.stdout}\n--- server stderr ---\n${output.stderr}`;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, host, () => {
      const address = listener.address();
      listener.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  if (child.pid) process.kill(-child.pid, "SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function assertIncludes(actual: string, expected: string, label: string): void {
  if (!actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())) {
    throw new Error(`${label}: expected body to include ${expected}, got ${actual.slice(0, 500)}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}