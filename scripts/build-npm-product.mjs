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

import {
  nativeNpmDistributions,
  npmDistributions,
  productsDirectory,
  releaseVersion,
} from "./npm-distributions.mjs";
import { resolveProductRuntimeDependencies } from "./product-runtime-closure.mjs";
import { SPARK_PROTOCOL_VERSION } from "../packages/spark-protocol/src/version.ts";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const buildNativeProducts = process.env.SPARK_SKIP_NATIVE_PRODUCTS !== "1";

const externalPackages = [
  "@zendev-lab/cue",
  "@ast-grep/napi",
  "@core-workspace/infoflow-sdk-nodejs",
  "@earendil-works/pi-ai",
  "esbuild",
  "@sveltejs/kit",
  "marked",
  "sanitize-html",
  "sharp",
  "web-push",
  "ws",
];

const esmRequireBanner = `import { createRequire as __sparkCreateRequire } from "node:module";
const require = __sparkCreateRequire(import.meta.url);`;

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
    "--target=node24",
    ...(output.endsWith("spark-headless-role-executor.js")
      ? [`--banner:js=${esmRequireBanner}`]
      : []),
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
  const discovered = await resolveProductRuntimeDependencies(
    root,
    distribution.directory,
    distribution.exactDependencies,
    distribution.declaredRuntimePackages,
  );
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
    ...(distribution.dsh ? { dsh: distribution.dsh } : {}),
    files: distribution.files,
    engines: { node: rootManifest.engines.node },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(distribution.optionalDependencies
      ? { optionalDependencies: sortedRecord(distribution.optionalDependencies) }
      : {}),
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
        deploymentGeneration: 2,
        fingerprint,
      },
      null,
      2,
    )}\n`,
  );
}

function launcherPrelude(preserveBuildInfo = false) {
  return `#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDist = resolve(packageDirectory, "dist");
process.env.SPARK_PRODUCT_DIST = productDist;
${preserveBuildInfo ? 'process.env.SPARK_BUILD_INFO_PATH ??= resolve(productDist, "build-info.json");' : 'process.env.SPARK_BUILD_INFO_PATH = resolve(productDist, "build-info.json");'}
`;
}

function resolvedDependencyPath(specifier) {
  return `fileURLToPath(import.meta.resolve(${JSON.stringify(specifier)}))`;
}

const cliCompanionExecutables = {
  "spark-daemon": "@zendev-lab/spark-daemon/executable",
  "spark-hub": "@zendev-lab/spark-hub/executable",
  "spark-web": "@zendev-lab/spark-web/executable",
};

function distributionPrelude(distribution, executableName) {
  const common = launcherPrelude();
  switch (distribution.id) {
    case "spark":
    case "cli":
      return `${common}process.env.SPARK_DAEMON_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-daemon/executable")};
process.env.SPARK_DAEMON_ENTRYPOINT = ${resolvedDependencyPath("@zendev-lab/spark-daemon/entrypoint")};
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = ${resolvedDependencyPath("@zendev-lab/spark-daemon/headless-role-executor")};
process.env.SPARK_HUB_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-hub/executable")};
process.env.SPARK_ACP_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-cli/acp-executable")};
process.env.SPARK_MCP_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-cli/mcp-executable")};
process.env.SPARK_PATHS_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-cli/paths-executable")};
process.env.SPARK_WEB_COMMAND = ${resolvedDependencyPath("@zendev-lab/spark-web/executable")};
`;
    case "daemon":
      return `${common}process.env.SPARK_DAEMON_ENTRYPOINT = resolve(productDist, "spark-daemon.js");
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = resolve(
  productDist,
  "spark-headless-role-executor.js",
);
`;
    case "hub":
      return `${common}process.env.SPARK_HUB_SERVER_ENTRYPOINT = resolve(
  productDist,
  "spark-hub-server.js",
);
process.env.SPARK_HUB_WEB_SERVICE_ENTRYPOINT = resolve(
  productDist,
  "spark-hub-web-service.js",
);
`;
    case "web":
      return common;
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
      if (distribution.id === "spark") {
        launcher = `${distributionPrelude(distribution, name)}const { runNativeSpark } = await import("@zendev-lab/spark-cli/resolver");
process.exitCode = runNativeSpark(process.argv.slice(2));
`;
      } else if (distribution.id === "cli" && cliCompanionExecutables[name]) {
        launcher = `${distributionPrelude(distribution, name)}const entry = ${resolvedDependencyPath(cliCompanionExecutables[name])};
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;
      } else if (name === "spark") {
        launcher = `${distributionPrelude(distribution, name)}const { runNativeSpark } = await import(
  pathToFileURL(resolve(productDist, "npm-resolver.mjs")).href
);
process.exitCode = runNativeSpark(process.argv.slice(2));
`;
      } else {
        launcher = `${distributionPrelude(distribution, name)}const entry = resolve(productDist, ${JSON.stringify(entry)});
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
if (buildNativeProducts) {
  for (const distribution of nativeNpmDistributions) {
    await mkdir(resolve(distribution.directory, "vendor", distribution.target), {
      recursive: true,
    });
  }
}

await run("node", ["scripts/sync-workspace-versions.mjs"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-daemon", "run", "build"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-hub", "run", "build"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-web", "run", "build"]);

await Promise.all(
  npmDistributions.flatMap((distribution) => [
    ...Object.entries(distribution.bundles).map(([output, entry]) =>
      bundle(entry, resolve(distribution.directory, "dist", output)),
    ),
    ...Object.entries(distribution.modules ?? {}).map(([output, source]) =>
      writeFile(resolve(distribution.directory, "dist", output), `${source.trimEnd()}\n`),
    ),
    ...Object.entries(distribution.copyModules ?? {}).map(([output, source]) =>
      cp(resolve(root, source), resolve(distribution.directory, "dist", output)),
    ),
  ]),
);

const daemon = npmDistributions.find((distribution) => distribution.id === "daemon");
const hub = npmDistributions.find((distribution) => distribution.id === "hub");
const web = npmDistributions.find((distribution) => distribution.id === "web");
if (!daemon || !hub || !web)
  throw new Error("Missing daemon, Hub, or web distribution configuration");
await Promise.all([
  cp(
    resolve(root, "apps/spark-daemon/dist/cli.js"),
    resolve(daemon.directory, "dist/spark-daemon.js"),
  ),
  cp(resolve(root, "apps/spark-hub/build"), resolve(hub.directory, "build"), {
    recursive: true,
  }),
  cp(resolve(root, "apps/spark-web/build"), resolve(web.directory, "build"), {
    recursive: true,
  }),
  ...npmDistributions.map(copyCommonFiles),
  ...(buildNativeProducts ? nativeNpmDistributions.map(copyCommonFiles) : []),
  ...npmDistributions
    .filter((distribution) => distribution.migrationSource)
    .map((distribution) =>
      cp(distribution.migrationSource, resolve(distribution.directory, "dist/migrations"), {
        recursive: true,
      }),
    ),
]);
const cli = npmDistributions.find((distribution) => distribution.id === "cli");
if (!cli) throw new Error("Missing CLI distribution configuration");
await cp(
  resolve(root, "packages/spark-i18n/src/cli-diagnostics.json"),
  resolve(cli.directory, "dist/cli-diagnostics.json"),
);

if (buildNativeProducts) {
  const nativeBinaryRoot = resolve(root, process.env.SPARK_NATIVE_BIN_DIR ?? "dist/native");
  for (const distribution of nativeNpmDistributions) {
    const source = resolve(nativeBinaryRoot, distribution.target, "spark");
    const destination = resolve(distribution.directory, "vendor", distribution.target, "spark");
    await cp(source, destination);
    await chmod(destination, 0o755);
    await writeFile(
      resolve(distribution.directory, "package.json"),
      `${JSON.stringify(
        {
          name: distribution.packageName,
          version: distribution.version,
          description: `Native Spark CLI payload for ${distribution.target}.`,
          license: rootManifest.license,
          author: rootManifest.author,
          repository: rootManifest.repository,
          os: [distribution.os],
          cpu: [distribution.cpu],
          files: ["vendor", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
          publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
        },
        null,
        2,
      )}\n`,
    );
  }
}

await run(process.execPath, ["scripts/verify-cue-package.mjs"]);
await removeSourceMaps(resolve(hub.directory, "build"));
await removeSourceMaps(resolve(web.directory, "build"));

const gitSha =
  process.env.SPARK_BUILD_GIT_SHA?.trim() ||
  (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
for (const distribution of npmDistributions) {
  await writeLaunchers(distribution);
  const dependencies = await runtimeDependencies(distribution);
  await Promise.all([
    writeProductManifest(distribution, dependencies),
    writeBuildInfo(distribution, gitSha, SPARK_PROTOCOL_VERSION),
  ]);
}

console.log(
  `Built npm distributions: ${[
    ...(buildNativeProducts
      ? nativeNpmDistributions.map(({ version }) => `@zendev-lab/spark-cli@${version}`)
      : []),
    ...npmDistributions.map(({ packageName }) => packageName),
  ].join(", ")}`,
);
