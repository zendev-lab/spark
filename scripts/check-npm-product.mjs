#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveProductRuntimeDependencies } from "./product-runtime-closure.mjs";

const root = process.cwd();
const productsDirectory = resolve(root, "dist/npm-products");
const products = [
  {
    id: "node",
    directory: resolve(productsDirectory, "node"),
    packageName: "@zendev-lab/spark",
    bins: ["spark", "spark-tui", "spark-daemon", "spark-acp", "spark-update"],
    requiredAssets: [
      "bin/spark",
      "bin/spark-tui",
      "bin/spark-daemon",
      "bin/spark-acp",
      "bin/spark-update",
      "dist/spark-cli.js",
      "dist/spark-tui.js",
      "dist/spark-daemon.js",
      "dist/spark-headless-role-executor.js",
      "dist/spark-acp.js",
      "dist/spark-update.js",
      "dist/build-info.json",
      "dist/migrations/0001_initial.sql",
      "skills/spark-cue/SKILL.md",
      "THIRD_PARTY_NOTICES.md",
    ],
    forbiddenAssets: [
      "bin/spark-hub",
      "dist/spark-hub.js",
      "dist/spark-hub-server.js",
      "dist/spark-hub-web-service.js",
      "build/handler.js",
    ],
  },
  {
    id: "hub",
    directory: resolve(productsDirectory, "hub"),
    packageName: "@zendev-lab/spark-hub",
    bins: ["spark-hub"],
    requiredAssets: [
      "bin/spark-hub",
      "dist/spark-hub.js",
      "dist/spark-hub-server.js",
      "dist/spark-hub-web-service.js",
      "dist/build-info.json",
      "dist/migrations/0001_initial.sql",
      "THIRD_PARTY_NOTICES.md",
      "build/handler.js",
    ],
    forbiddenAssets: [
      "bin/spark",
      "bin/spark-tui",
      "bin/spark-daemon",
      "bin/spark-acp",
      "bin/spark-update",
      "dist/spark-cli.js",
      "dist/spark-tui.js",
      "dist/spark-daemon.js",
      "dist/spark-headless-role-executor.js",
      "dist/spark-acp.js",
      "dist/spark-update.js",
      "skills/spark-cue/SKILL.md",
    ],
  },
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(join(directory, entry.name));
    else if (entry.isFile()) count += 1;
  }
  return count;
}

async function countSourceMaps(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += await countSourceMaps(path);
    else if (entry.isFile() && entry.name.endsWith(".map")) count += 1;
  }
  return count;
}

const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const failures = [];
const thirdPartyNoticePath = resolve(root, "THIRD_PARTY_NOTICES.md");
if (!(await exists(thirdPartyNoticePath))) {
  failures.push("source tree must include THIRD_PARTY_NOTICES.md");
} else {
  const notices = await readFile(thirdPartyNoticePath, "utf8");
  for (const required of [
    "Sikandar Bhide",
    "fa4bc217f84bc571378bc371332a154106772614",
    "Mitch Fultz",
    "cc2ac14d6a1e2bdf6baa1ee635bda0e08452bdd8",
  ]) {
    if (!notices.includes(required)) failures.push(`third-party notices must retain ${required}`);
  }
}
if (!(await exists(resolve(root, "packages/spark-loop/UPSTREAM-LICENSE.txt")))) {
  failures.push("spark-loop must retain its upstream MIT license");
}
const modelReproductionSkillDirectory = resolve(
  root,
  "packages/spark-host/skills/model-reproduction",
);
if (
  (await exists(modelReproductionSkillDirectory)) &&
  (await countFiles(modelReproductionSkillDirectory)) > 0
) {
  failures.push("Spark must not embed the model-reproduction domain skill");
}
if (rootManifest.private !== true) failures.push("source monorepo root must remain private");
for (const workspaceRoot of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, workspaceRoot, entry.name, "package.json");
    if (!(await exists(manifestPath))) continue;
    const workspace = JSON.parse(await readFile(manifestPath, "utf8"));
    if (workspace.private !== true)
      failures.push(`${workspace.name}: source workspace must be private`);
    if (workspace.publishConfig !== undefined) {
      failures.push(`${workspace.name}: source workspace must not declare publishConfig`);
    }
  }
}

for (const product of products) {
  const productManifestPath = resolve(product.directory, "package.json");
  if (!(await exists(productManifestPath))) continue;
  const manifest = JSON.parse(await readFile(productManifestPath, "utf8"));
  if (manifest.name !== product.packageName) {
    failures.push(`${product.id} product name must be ${product.packageName}`);
  }
  if (manifest.version !== rootManifest.version) {
    failures.push(`${product.id} product version must match the monorepo version`);
  }
  if (manifest.private === true) failures.push(`${product.id} npm product must be publishable`);
  const actualBins = Object.keys(manifest.bin ?? {}).sort();
  const expectedBins = [...product.bins].sort();
  if (JSON.stringify(actualBins) !== JSON.stringify(expectedBins)) {
    failures.push(
      `${product.id} product bins must be exactly ${expectedBins.join(", ")}; received ${actualBins.join(", ")}`,
    );
  }
  for (const name of product.bins) {
    if (manifest.bin?.[name] !== `./bin/${name}`) {
      failures.push(`${product.id} product must expose ${name} at ./bin/${name}`);
    }
  }
  if (manifest.bin?.["spark-cockpit"] !== undefined) {
    failures.push(`${product.id} product must not expose the retired spark-cockpit executable`);
  }
  if (
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    failures.push(`${product.id} publishConfig must target the public npm registry`);
  }
  for (const field of ["keywords", "repository", "homepage", "bugs"]) {
    if (rootManifest[field] !== undefined && manifest[field] === undefined) {
      failures.push(`${product.id} product must retain root ${field} metadata`);
    }
  }
  if (!manifest.files?.includes("THIRD_PARTY_NOTICES.md")) {
    failures.push(`${product.id} product files must include THIRD_PARTY_NOTICES.md`);
  }
  const expectedDependencies = await resolveProductRuntimeDependencies(root, product.directory);
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify(expectedDependencies)) {
    failures.push(`${product.id} dependencies must match its generated runtime closure`);
  }
  for (const asset of product.requiredAssets) {
    if (!(await exists(resolve(product.directory, asset)))) {
      failures.push(`${product.id} product is missing asset: ${asset}`);
    }
  }
  for (const asset of product.forbiddenAssets) {
    if (await exists(resolve(product.directory, asset))) {
      failures.push(`${product.id} product must omit asset: ${asset}`);
    }
  }
  if (await exists(resolve(product.directory, "skills/model-reproduction"))) {
    failures.push(`${product.id} product must not include the model-reproduction domain skill`);
  }
  const buildInfo = JSON.parse(
    await readFile(resolve(product.directory, "dist/build-info.json"), "utf8"),
  );
  if (
    buildInfo.packageName !== product.packageName ||
    buildInfo.version !== rootManifest.version ||
    !buildInfo.fingerprint
  ) {
    failures.push(`${product.id} product must expose matching build-info identity`);
  }
  const sourceMaps = await countSourceMaps(product.directory);
  if (sourceMaps > 0) {
    failures.push(`${product.id} product must omit runtime-unneeded source maps (${sourceMaps})`);
  }
}

if (failures.length) {
  throw new Error(`Invalid npm distributions:\n- ${failures.join("\n- ")}`);
}
const built = [];
for (const product of products) {
  const manifestPath = resolve(product.directory, "package.json");
  if (!(await exists(manifestPath))) continue;
  built.push(
    `${product.id}: ${await countFiles(product.directory)} files; manifest ${(await stat(manifestPath)).size} bytes`,
  );
}
console.log(
  built.length
    ? `Npm distribution policy valid (${built.join("; ")}).`
    : "Npm distribution policy valid.",
);
