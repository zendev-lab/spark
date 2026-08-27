import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const webDshManifest = JSON.parse(
  await readFile(resolve(root, "apps/spark-web-dsh/package.json"), "utf8"),
);

export const releaseVersion = rootManifest.version;
export const npmTag = releaseVersion.includes("-") ? "next" : "latest";
export const productsDirectory = resolve(root, "dist/npm-products");
export const releaseDirectory = resolve(root, "dist/release");

export const nativeNpmDistributions = [
  {
    id: "native-darwin-arm64",
    target: "aarch64-apple-darwin",
    suffix: "darwin-arm64",
    os: "darwin",
    cpu: "arm64",
  },
  {
    id: "native-linux-arm64",
    target: "aarch64-unknown-linux-musl",
    suffix: "linux-arm64",
    os: "linux",
    cpu: "arm64",
  },
  {
    id: "native-linux-x64",
    target: "x86_64-unknown-linux-musl",
    suffix: "linux-x64",
    os: "linux",
    cpu: "x64",
  },
].map((target) => ({
  ...target,
  packageName: "@zendev-lab/spark-cli",
  aliasPackageName: `@zendev-lab/spark-cli-${target.suffix}`,
  version: `${releaseVersion}-${target.suffix}`,
  directory: resolve(productsDirectory, "native", target.target),
  assetName: `spark-cli-${target.target}-npm-v${releaseVersion}.tgz`,
  manifestName: `native-${target.target}-release-manifest.json`,
}));

export const nativeOptionalDependencies = Object.fromEntries(
  nativeNpmDistributions.map((distribution) => [
    distribution.aliasPackageName,
    `npm:${distribution.packageName}@${distribution.version}`,
  ]),
);

export const npmDistributions = [
  {
    id: "spark",
    packageName: "@zendev-lab/spark",
    description:
      "Complete Spark installation metadata that pins the CLI, daemon, Hub, and web apps.",
    directory: resolve(productsDirectory, "spark"),
    assetName: `spark-v${releaseVersion}.tgz`,
    manifestName: "release-manifest.json",
    bins: { spark: "spark.js" },
    bundles: {},
    files: ["bin", "dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [
      "@zendev-lab/spark-cli",
      "@zendev-lab/spark-daemon",
      "@zendev-lab/spark-hub",
      "@zendev-lab/spark-web",
      "@zendev-lab/spark-web-dsh",
    ],
    exports: {},
  },
  {
    id: "cli",
    packageName: "@zendev-lab/spark-cli",
    description: rootManifest.description,
    directory: resolve(productsDirectory, "cli"),
    assetName: `spark-cli-v${releaseVersion}.tgz`,
    manifestName: "cli-release-manifest.json",
    bins: {
      spark: "npm-resolver.mjs",
      "spark-acp": "spark-acp.js",
      "spark-daemon": "spark-daemon-companion.js",
      "spark-hub": "spark-hub-companion.js",
      "spark-mcp": "spark-mcp.js",
      "spark-paths": "spark-paths.js",
      "spark-web": "spark-web-companion.js",
      "spark-web-dsh": "spark-web-dsh-companion.js",
    },
    bundles: {
      "spark-acp.js": "packages/spark-acp/bin/spark-acp.ts",
      "spark-mcp.js": "packages/spark-mcp/bin/spark-mcp.ts",
      "spark-paths.js": "apps/spark-cli/src/paths.ts",
    },
    copyModules: { "npm-resolver.mjs": "apps/spark-cli/src/npm-resolver.mjs" },
    files: ["bin", "dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [
      "@zendev-lab/spark-daemon",
      "@zendev-lab/spark-hub",
      "@zendev-lab/spark-web",
      "@zendev-lab/spark-web-dsh",
    ],
    exports: {
      "./acp-executable": "./bin/spark-acp",
      "./mcp-executable": "./bin/spark-mcp",
      "./executable": "./bin/spark",
      "./paths-executable": "./bin/spark-paths",
      "./resolver": "./dist/npm-resolver.mjs",
      "./web-executable": "./bin/spark-web",
      "./web-dsh-executable": "./bin/spark-web-dsh",
    },
    optionalDependencies: nativeOptionalDependencies,
    migrationSource: resolve(root, "apps/spark-daemon/dist/migrations"),
  },
  {
    id: "daemon",
    packageName: "@zendev-lab/spark-daemon",
    description: "Spark daemon service for durable local execution.",
    directory: resolve(productsDirectory, "daemon"),
    assetName: `spark-daemon-v${releaseVersion}.tgz`,
    manifestName: "daemon-release-manifest.json",
    bins: { "spark-daemon": "spark-daemon.js" },
    bundles: {
      "spark-headless-role-executor.js": "apps/spark-daemon/src/headless-role-executor.ts",
    },
    files: ["bin", "dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [],
    exports: {
      "./entrypoint": "./dist/spark-daemon.js",
      "./executable": "./bin/spark-daemon",
      "./headless-role-executor": "./dist/spark-headless-role-executor.js",
    },
    migrationSource: resolve(root, "apps/spark-daemon/dist/migrations"),
  },
  {
    id: "hub",
    packageName: "@zendev-lab/spark-hub",
    description: "Spark Hub control plane with an embedded Web management UI.",
    directory: resolve(productsDirectory, "hub"),
    assetName: `spark-hub-v${releaseVersion}.tgz`,
    manifestName: "hub-release-manifest.json",
    bins: { "spark-hub": "spark-hub.js" },
    bundles: {
      "spark-hub.js": "apps/spark-hub/src/cli-entry.ts",
      "spark-hub-server.js": "apps/spark-hub/server/index.ts",
      "spark-hub-web-service.js": "apps/spark-hub/src/cli/web-service-entry.ts",
    },
    files: ["bin", "dist", "build", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [],
    exports: { "./executable": "./bin/spark-hub" },
    migrationSource: resolve(root, "packages/spark-hub-storage-sqlite/src/migrations"),
  },
  {
    id: "web",
    packageName: "@zendev-lab/spark-web",
    description: "Local single-workspace Spark browser workbench bound to the daemon.",
    directory: resolve(productsDirectory, "web"),
    assetName: `spark-web-v${releaseVersion}.tgz`,
    manifestName: "web-release-manifest.json",
    bins: { "spark-web": "spark-web.js" },
    bundles: {
      "spark-web.js": "apps/spark-web/src/product-entry.ts",
    },
    files: ["bin", "dist", "build", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [],
    exports: { "./executable": "./bin/spark-web" },
  },
  {
    id: "web-dsh",
    packageName: "@zendev-lab/spark-web-dsh",
    description: "Optional DeepSeek Harness compatibility workbench for Spark.",
    directory: resolve(productsDirectory, "web-dsh"),
    assetName: `spark-web-dsh-v${releaseVersion}.tgz`,
    manifestName: "web-dsh-release-manifest.json",
    bins: { "spark-web-dsh": "spark-web-dsh.js" },
    bundles: {
      "spark-web-dsh.js": "apps/spark-web-dsh/src/cli-entry.ts",
    },
    files: ["bin", "dist", "lib", "presets", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [],
    dsh: webDshManifest.dsh,
    exports: {
      ".": "./lib/index.js",
      "./client": "./lib/client.js",
      "./executable": "./bin/spark-web-dsh",
      "./package.json": "./package.json",
    },
  },
];

export const npmDistributionById = new Map(
  npmDistributions.map((distribution) => [distribution.id, distribution]),
);
export const publicPackageNames = new Set(
  npmDistributions.map((distribution) => distribution.packageName),
);
