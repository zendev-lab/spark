#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { exerciseSparkDaemonLifecycle } from "../test/support/spark-process-harness.ts";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const legacyTarball = argumentValue("--tarball");
const suppliedNodeTarball = argumentValue("--node-tarball") ?? legacyTarball;
const suppliedHubTarball = argumentValue("--hub-tarball");
if ((suppliedNodeTarball && !suppliedHubTarball) || (!suppliedNodeTarball && suppliedHubTarball)) {
  throw new Error(
    "Supply both --node-tarball and --hub-tarball (legacy --tarball supplies node only)",
  );
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a path`);
  return value;
}

function cleanPath(extra = []) {
  const repoPrefix = `${root.replaceAll("\\", "/")}/`;
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter((entry) => {
    const portable = entry.replaceAll("\\", "/");
    const normalized = portable.endsWith("/") ? portable : `${portable}/`;
    return !normalized.startsWith(repoPrefix) && !normalized.includes("/node_modules/.bin/");
  });
  return [
    ...new Set([
      ...extra,
      dirname(process.execPath),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      ...pathEntries,
    ]),
  ].join(delimiter);
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? 120_000,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, {
      cause: error,
    });
  }
}

async function temporaryRoot() {
  const directory = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "spk-npm-"),
  );
  await chmod(directory, 0o700);
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("unsafe temporary root");
  return directory;
}

async function availablePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForHealth(url, child, output) {
  const startedAt = performance.now();
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Hub exited with ${child.exitCode}${output.stderr ? `\n${output.stderr.trim()}` : ""}`,
      );
    }
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (response.ok && body?.service === "spark-cockpit" && body?.status === "ok") {
        return performance.now() - startedAt;
      }
      lastError = new Error(`unexpected Hub health response ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Hub did not become healthy: ${String(lastError)}`);
}

async function probeHubRoute(url, child, output) {
  if (child.exitCode !== null) {
    throw new Error(
      `Hub exited with ${child.exitCode}${output.stderr ? `\n${output.stderr.trim()}` : ""}`,
    );
  }
  const startedAt = performance.now();
  const response = await fetch(url, {
    headers: { accept: "text/html" },
    redirect: "follow",
  });
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.startsWith("text/html")) {
    throw new Error(
      `unexpected Hub route response ${response.status} ${contentType || "<missing content-type>"}`,
    );
  }
  if (!/<title>[^<]*Spark[^<]*<\/title>/iu.test(body)) {
    throw new Error("Hub route did not render the Spark document shell");
  }
  const clientAssetSources = new Set([
    ...[...body.matchAll(/<script[^>]+src="([^"]+)"/giu)].map((match) => match[1]),
    ...[...body.matchAll(/import\(\s*["']([^"']+)["']\s*\)/gu)].map((match) => match[1]),
  ]);
  if (clientAssetSources.size === 0) {
    throw new Error("Hub route did not reference a client bundle");
  }
  for (const source of clientAssetSources) {
    const assetUrl = new URL(source, response.url);
    const asset = await fetch(assetUrl);
    if (!asset.ok) {
      throw new Error(`Hub client asset ${assetUrl.pathname} returned ${asset.status}`);
    }
    await asset.arrayBuffer();
  }
  return {
    routeMs: performance.now() - startedAt,
    clientAssetCount: clientAssetSources.size,
  };
}

function terminateProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // The process may have exited between the state check and the signal.
    }
  }
  child.kill("SIGTERM");
}

function installedBin(installRoot, packageName, name) {
  if (process.platform === "win32") {
    return {
      command: process.execPath,
      argvPrefix: [resolve(installRoot, "node_modules", packageName, "bin", name)],
    };
  }
  return {
    command: resolve(installRoot, "node_modules/.bin", name),
    argvPrefix: [],
  };
}

async function installTarball(temporary, id, tarballPath) {
  const installRoot = resolve(temporary, `install-${id}`);
  await mkdir(installRoot, { recursive: true });
  await run("npm", ["init", "--yes"], {
    cwd: installRoot,
    env: { ...process.env, PATH: cleanPath() },
  });
  await run("npm", ["install", "--ignore-scripts", tarballPath], {
    cwd: installRoot,
    env: { ...process.env, PATH: cleanPath() },
    timeout: 300_000,
  });
  return installRoot;
}

async function packProduct(temporary, id) {
  const destination = resolve(temporary, `pack-${id}`);
  await mkdir(destination, { recursive: true });
  await run("pnpm", ["pack", "--pack-destination", destination], {
    cwd: resolve(root, "dist/npm-products", id),
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  const tarballs = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`${id} pack expected one tarball, found ${tarballs.join(", ")}`);
  }
  return resolve(destination, tarballs[0]);
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(resolve(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

const temporary = await temporaryRoot();
try {
  let nodeTarballPath;
  let hubTarballPath;
  if (suppliedNodeTarball && suppliedHubTarball) {
    nodeTarballPath = resolve(root, suppliedNodeTarball);
    hubTarballPath = resolve(root, suppliedHubTarball);
    console.log(`Using prebuilt distributions ${nodeTarballPath} and ${hubTarballPath}...`);
  } else {
    console.log("Building npm distributions...");
    await run("node", ["scripts/build-npm-product.mjs"], {
      cwd: root,
      env: process.env,
      timeout: 300_000,
    });
    console.log("Packing generated npm distributions...");
    [nodeTarballPath, hubTarballPath] = await Promise.all([
      packProduct(temporary, "node"),
      packProduct(temporary, "hub"),
    ]);
  }

  const [nodePacked, hubPacked] = await Promise.all([stat(nodeTarballPath), stat(hubTarballPath)]);
  console.log("Installing node and Hub distributions independently...");
  const [nodeInstallRoot, hubInstallRoot] = await Promise.all([
    installTarball(temporary, "node", nodeTarballPath),
    installTarball(temporary, "hub", hubTarballPath),
  ]);

  const node = installedBin(nodeInstallRoot, "@zendev-lab/spark", "spark");
  const hub = installedBin(hubInstallRoot, "@zendev-lab/spark-hub", "spark-hub");
  const nodeEnvironment = {
    ...process.env,
    PATH: cleanPath(),
    SPARK_HOME: resolve(temporary, "spark-node-home"),
  };
  const hubEnvironment = {
    ...process.env,
    PATH: cleanPath(),
    SPARK_HOME: resolve(temporary, "spark-hub-home"),
  };

  console.log("Probing the installed node dispatcher, TUI, updater, and daemon...");
  await run(node.command, [...node.argvPrefix, "--help"], {
    cwd: nodeInstallRoot,
    env: nodeEnvironment,
  });
  const version = await run(node.command, [...node.argvPrefix, "version", "--json"], {
    cwd: nodeInstallRoot,
    env: nodeEnvironment,
  });
  const buildInfo = JSON.parse(version.stdout);
  if (buildInfo.packageName !== "@zendev-lab/spark" || !buildInfo.fingerprint) {
    throw new Error("node distribution did not expose valid build-info");
  }
  const updateStatus = await run(node.command, [...node.argvPrefix, "update", "status", "--json"], {
    cwd: nodeInstallRoot,
    env: nodeEnvironment,
  });
  if (JSON.parse(updateStatus.stdout).config?.policy !== "notify") {
    throw new Error("node distribution did not expose the default managed-update projection");
  }
  await run(node.command, [...node.argvPrefix, "tui", "--help"], {
    cwd: nodeInstallRoot,
    env: nodeEnvironment,
  });
  await exerciseSparkDaemonLifecycle({
    command: node.command,
    argvPrefix: node.argvPrefix,
    cwd: nodeInstallRoot,
    env: nodeEnvironment,
    timeoutMs: 120_000,
  });

  console.log("Probing separately installed Hub discovery through the root dispatcher...");
  await run(node.command, [...node.argvPrefix, "hub", "--help"], {
    cwd: nodeInstallRoot,
    env: {
      ...nodeEnvironment,
      PATH: cleanPath([resolve(hubInstallRoot, "node_modules/.bin")]),
    },
  });

  const port = await availablePort();
  console.log("Starting installed Hub health probe...");
  const hubProcess = spawn(hub.command, [...hub.argvPrefix], {
    cwd: hubInstallRoot,
    env: {
      ...hubEnvironment,
      HOST: "127.0.0.1",
      PORT: String(port),
      ORIGIN: `http://127.0.0.1:${port}`,
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const hubOutput = { stderr: "" };
  hubProcess.stderr.setEncoding("utf8");
  hubProcess.stderr.on("data", (chunk) => {
    hubOutput.stderr += chunk;
  });
  try {
    const origin = `http://127.0.0.1:${port}`;
    const healthReadyMs = await waitForHealth(`${origin}/api/v1/health`, hubProcess, hubOutput);
    const route = await probeHubRoute(origin, hubProcess, hubOutput);
    const workspaceRoute = await probeHubRoute(`${origin}/workspaces/new`, hubProcess, hubOutput);
    console.log(
      `SPARK_HUB_SMOKE_METRICS ${JSON.stringify({
        healthReadyMs: Math.round(healthReadyMs),
        routeMs: Math.round(route.routeMs),
        workspaceRouteMs: Math.round(workspaceRoute.routeMs),
        clientAssetCount: route.clientAssetCount,
      })}`,
    );
  } finally {
    terminateProcessTree(hubProcess);
    await new Promise((resolveExit) => {
      if (hubProcess.exitCode !== null || hubProcess.signalCode !== null) {
        resolveExit();
        return;
      }
      hubProcess.once("exit", resolveExit);
    });
  }

  const backgroundPort = await availablePort();
  const backgroundOrigin = `http://127.0.0.1:${backgroundPort}`;
  const backgroundEnvironment = {
    ...hubEnvironment,
    HOST: "127.0.0.1",
    PORT: String(backgroundPort),
    ORIGIN: backgroundOrigin,
  };
  console.log("Probing installed Hub background-service lifecycle...");
  try {
    const started = JSON.parse(
      (
        await run(hub.command, [...hub.argvPrefix, "web", "start", "--json"], {
          cwd: hubInstallRoot,
          env: backgroundEnvironment,
        })
      ).stdout,
    );
    if (!started.running) throw new Error("Hub background service did not report running");
    await probeHubRoute(`${backgroundOrigin}/workspaces/new`, { exitCode: null }, { stderr: "" });
    const status = JSON.parse(
      (
        await run(hub.command, [...hub.argvPrefix, "web", "status", "--json"], {
          cwd: hubInstallRoot,
          env: backgroundEnvironment,
        })
      ).stdout,
    );
    if (!status.running) throw new Error("Hub background service status was not running");
  } finally {
    await run(hub.command, [...hub.argvPrefix, "web", "stop", "--json"], {
      cwd: hubInstallRoot,
      env: backgroundEnvironment,
    });
  }

  const [nodeFileCount, hubFileCount] = await Promise.all([
    countFiles(resolve(nodeInstallRoot, "node_modules/@zendev-lab/spark")),
    countFiles(resolve(hubInstallRoot, "node_modules/@zendev-lab/spark-hub")),
  ]);
  console.log(
    `Npm distribution smoke passed (node ${nodePacked.size} bytes/${nodeFileCount} files; hub ${hubPacked.size} bytes/${hubFileCount} files).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
