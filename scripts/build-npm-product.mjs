#!/usr/bin/env node

/**
 * Assemble the two public npm distributions from the private monorepo:
 *
 * - @zendev-lab/spark: local node runtime (CLI, TUI, daemon, ACP, updater)
 * - @zendev-lab/spark-hub: Hub control plane with its embedded Web UI
 *
 * Source workspaces remain private implementation boundaries. A distribution
 * is a deployment/runtime closure, not a new source ownership boundary.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveProductRuntimeDependencies } from "./product-runtime-closure.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productsDirectory = resolve(root, "dist/npm-products");
let rootManifest;

// These packages are intentionally left outside the esbuild bundles. Each
// generated manifest is derived independently from that distribution's JS
// closure, including SvelteKit lazy server chunks for Hub.
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

const distributions = {
  node: {
    id: "node",
    packageName: "@zendev-lab/spark",
    description: "Spark local node runtime: CLI, TUI, daemon, ACP, and updater.",
    directory: resolve(productsDirectory, "node"),
    bins: {
      spark: "spark-cli.js",
      "spark-tui": "spark-tui.js",
      "spark-daemon": "spark-daemon.js",
      "spark-acp": "spark-acp.js",
      "spark-update": "spark-update.js",
    },
    files: ["bin", "dist", "skills", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  },
  hub: {
    id: "hub",
    packageName: "@zendev-lab/spark-hub",
    description: "Spark Hub control plane with an embedded Web management UI.",
    directory: resolve(productsDirectory, "hub"),
    bins: {
      "spark-hub": "spark-hub.js",
    },
    files: ["bin", "dist", "build", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  },
};

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

async function writeProductManifest(distribution, dependencies) {
  const manifest = {
    name: distribution.packageName,
    version: rootManifest.version,
    description: distribution.description,
    license: rootManifest.license,
    author: rootManifest.author,
    ...(rootManifest.keywords ? { keywords: rootManifest.keywords } : {}),
    ...(rootManifest.repository ? { repository: rootManifest.repository } : {}),
    ...(rootManifest.homepage ? { homepage: rootManifest.homepage } : {}),
    ...(rootManifest.bugs ? { bugs: rootManifest.bugs } : {}),
    type: "module",
    bin: Object.fromEntries(
      Object.keys(distribution.bins).map((name) => [name, `./bin/${name}`]),
    ),
    files: distribution.files,
    engines: { node: rootManifest.engines.node },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org/",
    },
    dependencies,
  };
  await writeFile(
    resolve(distribution.directory, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function latestMigrationName(directory) {
  const migrationNames = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return migrationNames.at(-1) ?? "none";
}

async function writeBuildInfo(distribution, gitSha, protocolVersion) {
  const migrationHead =
    distribution.id === "node"
      ? await latestMigrationName(resolve(distribution.directory, "dist/migrations"))
      : await latestMigrationName(resolve(root, "packages/spark-cockpit-db/src/migrations"));
  const fingerprintMigration =
    distribution.id === "node" ? migrationHead : `hub:${migrationHead}`;
  const fingerprint = `sha256:${createHash("sha256")
    .update(
      [rootManifest.version, gitSha, String(protocolVersion), fingerprintMigration].join("\n"),
    )
    .digest("hex")}`;
  const buildInfo = {
    schemaVersion: 1,
    packageName: distribution.packageName,
    version: rootManifest.version,
    gitSha,
    protocolVersion,
    minimumNodeVersion: rootManifest.engines.node,
    migrationHead,
    migrationMode: rootManifest.sparkRelease.migrationMode,
    fingerprint,
  };
  await writeFile(
    resolve(distribution.directory, "dist/build-info.json"),
    `${JSON.stringify(buildInfo, null, 2)}\n`,
  );
}

function launcherPrelude(distribution) {
  const common = `#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productDist = resolve(packageDirectory, "dist");
process.env.SPARK_PRODUCT_DIST = productDist;
process.env.SPARK_BUILD_INFO_PATH = resolve(productDist, "build-info.json");
`;
  if (distribution.id === "node") {
    return `${common}process.env.SPARK_DAEMON_ENTRYPOINT = resolve(productDist, "spark-daemon.js");
process.env.SPARK_HEADLESS_EXECUTOR_MODULE = resolve(
  productDist,
  "spark-headless-role-executor.js",
);
`;
  }
  return `${common}process.env.SPARK_COCKPIT_SERVER_ENTRYPOINT = resolve(
  productDist,
  "spark-hub-server.js",
);
process.env.SPARK_COCKPIT_WEB_SERVICE_ENTRYPOINT = resolve(
  productDist,
  "spark-hub-web-service.js",
);
`;
}

async function writeLaunchers(distribution) {
  const binDirectory = resolve(distribution.directory, "bin");
  const productDist = resolve(distribution.directory, "dist");
  await mkdir(binDirectory, { recursive: true });
  await Promise.all(
    Object.entries(distribution.bins).map(async ([name, entry]) => {
      const launcher =
        name === "spark"
          ? `${launcherPrelude(distribution)}
const { runSparkDispatcher } = await import(
  pathToFileURL(resolve(productDist, "spark-cli.js")).href
);
process.exitCode = await runSparkDispatcher(process.argv.slice(2));
`
          : `${launcherPrelude(distribution)}
const entry = resolve(productDist, ${JSON.stringify(entry)});
process.argv[1] = entry;
await import(pathToFileURL(entry).href);
`;
      const destination = resolve(binDirectory, name);
      await writeFile(destination, launcher);
      await chmod(destination, 0o755);
    }),
  );
}

async function removeSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await removeSourceMaps(path);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      await rm(path);
    }
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
for (const distribution of Object.values(distributions)) {
  await mkdir(resolve(distribution.directory, "dist"), { recursive: true });
}
rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

await run("pnpm", ["--filter", "@zendev-lab/spark-daemon", "run", "build"]);
await run("pnpm", ["--filter", "@zendev-lab/spark-hub", "run", "build"]);

const nodeDist = resolve(distributions.node.directory, "dist");
const hubDist = resolve(distributions.hub.directory, "dist");
await Promise.all([
  bundle("apps/spark-cli/src/cli.ts", resolve(nodeDist, "spark-cli.js")),
  bundle("apps/spark-tui/src/cli.ts", resolve(nodeDist, "spark-tui.js")),
  bundle(
    "apps/spark-tui/src/headless-role-executor.ts",
    resolve(nodeDist, "spark-headless-role-executor.js"),
  ),
  bundle("packages/spark-acp/scripts/stdio.ts", resolve(nodeDist, "spark-acp.js")),
  bundle("packages/spark-update/src/entry.ts", resolve(nodeDist, "spark-update.js")),
  bundle("apps/spark-cockpit/src/cli-entry.ts", resolve(hubDist, "spark-hub.js")),
  bundle(
    "apps/spark-cockpit/src/cli/web-service-entry.ts",
    resolve(hubDist, "spark-hub-web-service.js"),
  ),
  bundle("apps/spark-cockpit/server/index.ts", resolve(hubDist, "spark-hub-server.js")),
]);

await Promise.all([
  cp(resolve(root, "apps/spark-daemon/dist/cli.js"), resolve(nodeDist, "spark-daemon.js")),
  cp(resolve(root, "apps/spark-daemon/dist/migrations"), resolve(nodeDist, "migrations"), {
    recursive: true,
  }),
  cp(resolve(root, "apps/spark-cockpit/build"), resolve(distributions.hub.directory, "build"), {
    recursive: true,
  }),
  copyCommonFiles(distributions.node),
  copyCommonFiles(distributions.hub),
]);
await cp(
  resolve(root, "packages/spark-cue/skills/spark-cue"),
  resolve(distributions.node.directory, "skills/spark-cue"),
  { recursive: true },
);
await removeSourceMaps(resolve(distributions.hub.directory, "build"));

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

for (const distribution of Object.values(distributions)) {
  await writeLaunchers(distribution);
  const dependencies = await resolveProductRuntimeDependencies(root, distribution.directory);
  await Promise.all([
    writeProductManifest(distribution, dependencies),
    writeBuildInfo(distribution, gitSha, protocolVersion),
  ]);
}

console.log(`Built npm distributions: ${productsDirectory}`);
