import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

export const releaseVersion = rootManifest.version;
export const npmTag = releaseVersion.includes("-") ? "next" : "latest";
export const productsDirectory = resolve(root, "dist/npm-products");
export const releaseDirectory = resolve(root, "dist/release");

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
      spark: "spark-cli.js",
      "spark-acp": "spark-acp.js",
      "spark-daemon": "spark-daemon-companion.js",
      "spark-hub": "spark-hub-companion.js",
      "spark-mcp": "spark-mcp.js",
      "spark-web": "spark-web-companion.js",
      "spark-update": "spark-update.js",
    },
    bundles: {
      "spark-cli.js": "apps/spark-cli/src/cli.ts",
      "spark-acp.js": "packages/spark-acp/bin/spark-acp.ts",
      "spark-mcp.js": "packages/spark-mcp/bin/spark-mcp.ts",
      "spark-update.js": "packages/spark-update/src/entry.ts",
    },
    files: ["bin", "dist", "skills", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [
      "@zendev-lab/spark-daemon",
      "@zendev-lab/spark-hub",
      "@zendev-lab/spark-web",
    ],
    exports: {
      "./cli": "./dist/spark-cli.js",
      "./mcp-executable": "./bin/spark-mcp",
      "./executable": "./bin/spark",
      "./update-executable": "./bin/spark-update",
      "./web-executable": "./bin/spark-web",
    },
    skills: true,
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
      "spark-headless-role-executor.js": "packages/spark-extension/src/headless-role-executor.ts",
    },
    files: ["bin", "dist", "skills", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
    exactDependencies: [],
    exports: {
      "./entrypoint": "./dist/spark-daemon.js",
      "./executable": "./bin/spark-daemon",
      "./headless-role-executor": "./dist/spark-headless-role-executor.js",
    },
    skills: true,
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
    migrationSource: resolve(root, "packages/spark-hub-db/src/migrations"),
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
];

export const npmDistributionById = new Map(
  npmDistributions.map((distribution) => [distribution.id, distribution]),
);
export const publicPackageNames = new Set(
  npmDistributions.map((distribution) => distribution.packageName),
);
