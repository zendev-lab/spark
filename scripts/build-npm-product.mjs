#!/usr/bin/env node

/**
 * Assemble the public, lockstep-versioned npm distributions from the private
 * source monorepo. The root manifest owns @zendev-lab/spark; executable apps
 * own their package identities, while generated artifacts contain compiled JS
 * and no workspace protocol dependencies.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { npmDistributions, productsDirectory, releaseVersion } from "./npm-distributions.mjs";
import { resolveProductRuntimeDependencies } from "./product-runtime-closure.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const externalPackages = [
  "@ast-grep/napi",
  "@core-workspace/infoflow-sdk-nodejs",
  "@cursor/sdk",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "@sveltejs/kit",
  "marked",
  "sanitize-html",
  "web-push",
  "ws",
];

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: root,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    const output = [error?.stdout, error?.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `\n${output}` : ""}`, {
      cause: error,
    });
  }
}

async function bundle(entry, output) {
  await run("pnpm", [
    "exec",
    "esbuild",
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node26",
    `--outfile=${output}`,
    ...externalPackages.map((name) => `--external:${name}`),
  ]);
}

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function runtimeDependencies(distribution) {
  const discovered = await resolveProductRuntimeDependencies(root, distribution.directory);
  const exact = Object.fromEntries(
    distribution.exactDependencies.map((name) => [name, releaseVersion]),
  );
  return sortedRecord({ ...discovered, ...exact });
}

async function writeProductManifest(distribution, dependencies) {
  const manifest = {
    name: distribution.packageName,
    version: releaseVersion,
    description: distribution.description,
    license: rootManifest.license,
    author: rootManifest.author,
    ...(rootManifest.keywords ? { keywords: rootManifest.keywords } : {}),
    ...(rootManifest.repository ? { repository: rootManifest.repository } : {}),
    ...(rootManifest.homepage ? { homepage: rootManifest.homepage } : {}),
    ...(rootManifest.bugs ? { bugs: rootManifest.bugs } : {}),
    type: "module",
    ...(Object.keys(distribution.bins).length > 0
      ? {
          bin: Object.fromEntries(
            Object.keys(distribution.bins).map((name) => [name, `./bin/${name}`]),
          ),
        }
      : {}),
    ...(Object.keys(distribution.exports).length > 0 ? { exports: distribution.exports } : {}),
    files: distribution.files,
    engines: { node: rootManifest.engines.node },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
  };
  await writeFile(
    resolve(distribution.directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function latestMigrationName(distribution) {
  if (!distribution.migrationSource) return "none";
  const names = (await readdir(resolve(distribution.directory, "dist/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return names.at(-1) ?? "none";
}

async function writeBuildInfo(distribution, gitSha, protocolVersion) {
  const migrationHead = await latestMigrationName(distribution);
  const fingerprint = `sha256:${createHash("sha256")
    .update(
      [releaseVersion, gitSha, String(protocolVersion), distribution.id, migrationHead].join("\n"),
    )
    .digest("hex")}`;
  await writeFile(
    resolve(distribution.directory, "dist/build-info.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageName: distribution.packageName,
        version: releaseVersion,
        gitSha,
        protocolVersion,
        minimumNodeVersion: rootManifest.engines.node,
        migrationHead,
        migrationMode: rootManifest.sparkRelease.migrationMode,
        fingerprint,
      },
      null,
      2,
    )}\n`,
  );
}

function launcherPrelude() {
  return `#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDist = resolve(packageDirectory, "dist");
process.env.SPARK_PRODUCT_DIST = productDist;
process.env.SPARK_BUILD_INFO_PATH = resolve(productDist, "build-info.json");
`;
}

function resolvedDependencyPath(specifier) {
  return `fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}))`;
}

const rootCompanionExecutables = {
  "spark-daemon": "@zendev-lab/spark-daemon/executable",
  "spark-hub": "@zendev-lab/spark-hub/executable",
  "spark-tui": "@zendev-lab/spark-tui/executable",
};

function distributionPrelude(distribution) {
  const common = launcherPrelude();
  switch (distribution.id) {
    case "spark":
      return `${common}process.env.SPARK_DAEMON_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-daemon/executable")};
process.env.SPARK_DAEMON_ENTRYPOINT = ${resolvedDependencyPath("@zendev-lab/spark-daemon/entrypoint")};
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = ${resolvedDependencyPath("@zendev-lab/spark-daemon/headless-role-executor")};
process.env.SPARK_HUB_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-hub/executable")};
process.env.SPARK_TUI_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-tui/executable")};
`;
    case "daemon":
      return `${common}process.env.SPARK_DAEMON_ENTRYPOINT = resolve(productDist, "spark-daemon.js");
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = resolve(
  productDist,
  "spark-headless-role-executor.js",
);
`;
    case "tui":
      return `${common}process.env.SPARK_DAEMON_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-daemon/executable")};
process.env.SPARK_DAEMON_ENTRYPOINT = ${resolvedDependencyPath("@zendev-lab/spark-daemon/entrypoint")};
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = ${resolvedDependencyPath("@zendev-lab/spark-daemon/headless-role-executor")};
`;
    case "hub":
      return `${common}process.env.SPARK_COCKPIT_SERVER_ENTRYPOINT = resolve(
  productDist,
  "spark-hub-server.js",
);
process.env.SPARK_COCKPIT_WEB_SERVICE_ENTRYPOINT = resolve(
  productDist,
  "spark-hub-web-service.js",
);
`;
    default:
      return common;
  }
}

async function writeLaunchers(distribution) {
  const binDirectory = resolve(distribution.directory, "bin");
  const productDist = resolve(distribution.directory, "dist");
  await mkdir(binDirectory, { recursive: true });
  await Promise.all(
    Object.entries(distribution.bins).map(async ([name, entry]) => {
      let launcher;
      if (distribution.id === "cli") {
        launcher = `${launcherPrelude()}const entry = ${resolvedDependencyPath("@zendev-lab/spark/executable")};
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;
      } else if (distribution.id === "spark" && rootCompanionExecutables[name]) {
        launcher = `${distributionPrelude(distribution)}const entry = ${resolvedDependencyPath(rootCompanionExecutables[name])};
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;
      } else if (name === "spark") {
        launcher = `${distributionPrelude(distribution)}const { runSparkDispatcher } = await import(
  pathToFileURL(resolve(productDist, "spark-cli.js")).href
);
process.exitCode = await runSparkDispatcher(process.argv.slice(2));
`;
      } else {
        launcher = `${distributionPrelude(distribution)}const entry = resolve(productDist, ${JSON.stringify(entry)});
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;
      }
      const destination = resolve(binDirectory, name);
      await writeFile(destination, launcher);
      await chmod(destination, 0o755);
    }),
  );
}

async function removeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await removeSourceMaps(path);
    else if (entry.isFile() && entry.name.endsWith(".map")) await rm(path);
  }
}

async function copyCommonFiles(distribution) {
  await Promise.all([
    cp(resolve(root, "README.md"), resolve(distribution.directory, "README.md")),
    cp(resolve(root, "LICENSE"), resolve(distribution.directory, "LICENSE")),
    cp(
      resolve(root, "THIRD_PARTY_NOTICES.md"),
      resolve(distribution.directory, "THIRD_PARTY_NOTICES.md"),
    ),
  ]);
}

await rm(productsDirectory, { recursive: true, force: true });
for (const distribution of npmDistributions) {
  await mkdir(resolve(distribution.directory, "dist"), { recursive: true });
}

await run("node", ["scripts/sync-workspace-versions.mjs"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-daemon", "run", "build"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-hub", "run", "build"]);

await Promise.all(
  npmDistributions.flatMap((distribution) =>
    Object.entries(distribution.bundles).map(([output, entry]) =>
      bundle(entry, resolve(distribution.directory, "dist", output)),
    ),
  ),
);

const daemon = npmDistributions.find((distribution) => distribution.id === "daemon");
const hub = npmDistributions.find((distribution) => distribution.id === "hub");
if (!daemon || !hub) throw new Error("Missing daemon or Hub distribution configuration");
await Promise.all([
  cp(
    resolve(root, "apps/spark-daemon/dist/cli.js"),
    resolve(daemon.directory, "dist/spark-daemon.js"),
  ),
  cp(resolve(root, "apps/spark-cockpit/build"), resolve(hub.directory, "build"), {
    recursive: true,
  }),
  ...npmDistributions.map(copyCommonFiles),
  ...npmDistributions
    .filter((distribution) => distribution.migrationSource)
    .map((distribution) =>
      cp(distribution.migrationSource, resolve(distribution.directory, "dist/migrations"), {
        recursive: true,
      }),
    ),
]);

await Promise.all(
  npmDistributions
    .filter((distribution) => distribution.skills)
    .map((distribution) =>
      cp(
        resolve(root, "packages/spark-cue/skills/spark-cue"),
        resolve(distribution.directory, "skills/spark-cue"),
        { recursive: true },
      ),
    ),
);
await removeSourceMaps(resolve(hub.directory, "build"));

const gitSha =
  process.env.SPARK_BUILD_GIT_SHA?.trim() ||
  (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
const protocolSource = await readFile(
  resolve(root, "packages/spark-protocol/src/version.ts"),
  "utf8",
);
const protocolVersion = Number(/SPARK_PROTOCOL_VERSION\s*=\s*(\d+)/u.exec(protocolSource)?.[1]);
if (!Number.isSafeInteger(protocolVersion)) {
  throw new TypeError("Unable to resolve SPARK_PROTOCOL_VERSION for build-info.json");
}

for (const distribution of npmDistributions) {
  await writeLaunchers(distribution);
  const dependencies = await runtimeDependencies(distribution);
  await Promise.all([
    writeProductManifest(distribution, dependencies),
    writeBuildInfo(distribution, gitSha, protocolVersion),
  ]);
}

console.log(
  `Built npm distributions: ${npmDistributions.map(({ packageName }) => packageName).join(", ")}`,
);
