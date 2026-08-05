#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { npmDistributions, releaseVersion } from "./npm-distributions.mjs";
import { exerciseSparkDaemonLifecycle } from "../test/support/spark-process-harness.ts";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const supplied = suppliedTarballs();

function argumentValue(...names) {
  for (const name of names) {
    const index = process.argv.indexOf(name);
    if (index < 0) continue;
    const value = process.argv[index + 1];
    if (!value) throw new Error(`${name} requires a path`);
    return value;
  }
  return undefined;
}

function suppliedTarballs() {
  const values = {
    spark: argumentValue("--spark-tarball", "--node-tarball", "--tarball"),
    cli: argumentValue("--cli-tarball"),
    daemon: argumentValue("--daemon-tarball"),
    tui: argumentValue("--tui-tarball"),
    hub: argumentValue("--hub-tarball"),
  };
  const count = Object.values(values).filter(Boolean).length;
  if (count !== 0 && count !== npmDistributions.length) {
    throw new Error(
      "Supply all five release tarballs: --spark-tarball, --cli-tarball, --daemon-tarball, --tui-tarball, and --hub-tarball",
    );
  }
  return count === 0 ? undefined : values;
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
    if (!asset.ok)
      throw new Error(`Hub client asset ${assetUrl.pathname} returned ${asset.status}`);
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
  return {
    command: process.execPath,
    argvPrefix: [resolve(installRoot, "node_modules", packageName, "bin", name)],
  };
}

function fileSpecifier(_fromDirectory, file) {
  return pathToFileURL(file).href;
}

async function installCandidates(temporary, id, packageIds, tarballs) {
  const installRoot = resolve(temporary, `install-${id}`);
  await mkdir(installRoot, { recursive: true });
  const dependencies = Object.fromEntries(
    packageIds.map((packageId) => {
      const distribution = npmDistributions.find(({ id: candidate }) => candidate === packageId);
      if (!distribution) throw new Error(`Unknown distribution ${packageId}`);
      return [distribution.packageName, fileSpecifier(installRoot, tarballs[packageId])];
    }),
  );
  await writeFile(
    resolve(installRoot, "package.json"),
    `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
  );
  await run("npm", ["install", "--ignore-scripts", "--no-package-lock"], {
    cwd: installRoot,
    env: { ...process.env, PATH: cleanPath() },
    timeout: 300_000,
  });
  return installRoot;
}

async function packProduct(temporary, distribution) {
  const destination = resolve(temporary, `pack-${distribution.id}`);
  await mkdir(destination, { recursive: true });
  await run("npm", ["pack", "--json", "--pack-destination", destination], {
    cwd: distribution.directory,
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
  const tarballs = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`${distribution.id} pack expected one tarball, found ${tarballs.join(", ")}`);
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
  let tarballs;
  if (supplied) {
    tarballs = Object.fromEntries(
      Object.entries(supplied).map(([id, path]) => [id, resolve(root, path)]),
    );
    console.log(`Using five prebuilt npm distributions at ${releaseVersion}...`);
  } else {
    console.log("Building npm distributions...");
    await run("node", ["scripts/build-npm-product.mjs"], {
      cwd: root,
      env: process.env,
      timeout: 300_000,
    });
    console.log("Packing generated npm distributions...");
    tarballs = Object.fromEntries(
      await Promise.all(
        npmDistributions.map(async (distribution) => [
          distribution.id,
          await packProduct(temporary, distribution),
        ]),
      ),
    );
  }

  const packedStats = Object.fromEntries(
    await Promise.all(Object.entries(tarballs).map(async ([id, path]) => [id, await stat(path)])),
  );
  console.log(
    "Installing the complete product, CLI shell, and standalone apps from exact tarballs...",
  );
  const allIds = npmDistributions.map(({ id }) => id);
  const [completeRoot, cliRoot, daemonRoot, tuiRoot, hubRoot] = await Promise.all([
    installCandidates(temporary, "complete", allIds, tarballs),
    installCandidates(temporary, "cli", allIds, tarballs),
    installCandidates(temporary, "daemon", ["daemon"], tarballs),
    installCandidates(temporary, "tui", ["tui", "daemon"], tarballs),
    installCandidates(temporary, "hub", ["hub"], tarballs),
  ]);

  const spark = installedBin(completeRoot, "@zendev-lab/spark", "spark");
  const completeDaemon = installedBin(completeRoot, "@zendev-lab/spark", "spark-daemon");
  const completeHub = installedBin(completeRoot, "@zendev-lab/spark", "spark-hub");
  const completeTui = installedBin(completeRoot, "@zendev-lab/spark", "spark-tui");
  const cliShell = installedBin(cliRoot, "@zendev-lab/spark-cli", "spark");
  const daemon = installedBin(daemonRoot, "@zendev-lab/spark-daemon", "spark-daemon");
  const tui = installedBin(tuiRoot, "@zendev-lab/spark-tui", "spark-tui");
  const hub = installedBin(hubRoot, "@zendev-lab/spark-hub", "spark-hub");
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

  console.log("Probing the complete root package and the spark-cli compatibility shell...");
  await run(spark.command, [...spark.argvPrefix, "--help"], {
    cwd: completeRoot,
    env: nodeEnvironment,
  });
  const version = await run(spark.command, [...spark.argvPrefix, "version", "--json"], {
    cwd: completeRoot,
    env: nodeEnvironment,
  });
  const buildInfo = JSON.parse(version.stdout);
  if (buildInfo.packageName !== "@zendev-lab/spark" || !buildInfo.fingerprint) {
    throw new Error("root distribution did not expose valid build-info");
  }
  const shellVersion = JSON.parse(
    (
      await run(cliShell.command, [...cliShell.argvPrefix, "version", "--json"], {
        cwd: cliRoot,
        env: { ...nodeEnvironment, SPARK_HOME: resolve(temporary, "spark-cli-home") },
      })
    ).stdout,
  );
  if (shellVersion.fingerprint !== buildInfo.fingerprint) {
    throw new Error("spark-cli shell did not forward to the root Spark build");
  }
  const updateStatus = await run(
    spark.command,
    [...spark.argvPrefix, "update", "status", "--json"],
    {
      cwd: completeRoot,
      env: nodeEnvironment,
    },
  );
  if (JSON.parse(updateStatus.stdout).config?.policy !== "notify") {
    throw new Error("root distribution did not expose the default managed-update projection");
  }
  await Promise.all([
    run(completeDaemon.command, [...completeDaemon.argvPrefix, "--help"], {
      cwd: completeRoot,
      env: nodeEnvironment,
    }),
    run(completeHub.command, [...completeHub.argvPrefix, "--help"], {
      cwd: completeRoot,
      env: nodeEnvironment,
    }),
    run(completeTui.command, [...completeTui.argvPrefix, "--help"], {
      cwd: completeRoot,
      env: nodeEnvironment,
    }),
  ]);
  await run(spark.command, [...spark.argvPrefix, "tui", "--help"], {
    cwd: completeRoot,
    env: nodeEnvironment,
  });
  await exerciseSparkDaemonLifecycle({
    command: spark.command,
    argvPrefix: spark.argvPrefix,
    cwd: completeRoot,
    env: nodeEnvironment,
    timeoutMs: 120_000,
  });

  console.log("Probing independently installed daemon and TUI packages...");
  await run(daemon.command, [...daemon.argvPrefix, "--help"], {
    cwd: daemonRoot,
    env: { ...nodeEnvironment, SPARK_HOME: resolve(temporary, "standalone-daemon-home") },
  });
  await run(tui.command, [...tui.argvPrefix, "--help"], {
    cwd: tuiRoot,
    env: { ...nodeEnvironment, SPARK_HOME: resolve(temporary, "standalone-tui-home") },
  });

  const port = await availablePort();
  console.log("Starting independently installed Hub health probe...");
  const hubProcess = spawn(hub.command, [...hub.argvPrefix], {
    cwd: hubRoot,
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
          cwd: hubRoot,
          env: backgroundEnvironment,
        })
      ).stdout,
    );
    if (!started.running) throw new Error("Hub background service did not report running");
    await probeHubRoute(`${backgroundOrigin}/workspaces/new`, { exitCode: null }, { stderr: "" });
    const status = JSON.parse(
      (
        await run(hub.command, [...hub.argvPrefix, "web", "status", "--json"], {
          cwd: hubRoot,
          env: backgroundEnvironment,
        })
      ).stdout,
    );
    if (!status.running) throw new Error("Hub background service status was not running");
  } finally {
    await run(hub.command, [...hub.argvPrefix, "web", "stop", "--json"], {
      cwd: hubRoot,
      env: backgroundEnvironment,
    });
  }

  const fileCounts = Object.fromEntries(
    await Promise.all(
      npmDistributions.map(async (distribution) => [
        distribution.id,
        await countFiles(
          resolve(completeRoot, "node_modules", ...distribution.packageName.split("/")),
        ),
      ]),
    ),
  );
  console.log(
    `Npm distribution smoke passed (${npmDistributions
      .map(({ id }) => `${id} ${packedStats[id].size} bytes/${fileCounts[id]} files`)
      .join("; ")}).`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
