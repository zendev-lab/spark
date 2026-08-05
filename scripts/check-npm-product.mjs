#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { npmDistributions, productsDirectory, releaseVersion } from "./npm-distributions.mjs";
import { resolveProductRuntimeDependencies } from "./product-runtime-closure.mjs";

const root = process.cwd();
const failures = [];

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

function sortedRecord(record) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (rootManifest.name !== "@zendev-lab/spark") {
  failures.push("root manifest must own the @zendev-lab/spark product identity");
}
if (rootManifest.private !== true) failures.push("source monorepo root must remain private");
if (rootManifest.version !== releaseVersion) {
  failures.push("distribution version must come from the root manifest");
}

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

const expectedApplicationNames = new Map([
  ["spark-cli", "@zendev-lab/spark-cli"],
  ["spark-cockpit", "@zendev-lab/spark-hub"],
  ["spark-daemon", "@zendev-lab/spark-daemon"],
  ["spark-tui", "@zendev-lab/spark-tui"],
]);
for (const workspaceRoot of ["apps", "packages"]) {
  for (const entry of await readdir(resolve(root, workspaceRoot), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(root, workspaceRoot, entry.name, "package.json");
    if (!(await exists(manifestPath))) continue;
    const workspace = JSON.parse(await readFile(manifestPath, "utf8"));
    if (workspace.private !== true) {
      failures.push(`${workspace.name}: source workspace must be private`);
    }
    if (workspace.publishConfig !== undefined) {
      failures.push(`${workspace.name}: source workspace must not declare publishConfig`);
    }
    if (entry.name !== "spark-mcp-spike" && workspace.version !== releaseVersion) {
      failures.push(`${workspace.name}: source workspace version must match ${releaseVersion}`);
    }
    const expectedName = workspaceRoot === "apps" ? expectedApplicationNames.get(entry.name) : null;
    if (expectedName && workspace.name !== expectedName) {
      failures.push(`apps/${entry.name} must own ${expectedName}, received ${workspace.name}`);
    }
  }
}

const internalTui = JSON.parse(
  await readFile(resolve(root, "packages/spark-tui/package.json"), "utf8"),
);
if (internalTui.name !== "@zendev-lab/spark-tui-adapter") {
  failures.push("packages/spark-tui must use the internal spark-tui-adapter identity");
}

const assetPolicy = {
  spark: {
    required: ["bin/spark", "dist/build-info.json"],
    forbidden: [
      "bin/spark-acp",
      "bin/spark-daemon",
      "bin/spark-hub",
      "bin/spark-mcp",
      "bin/spark-tui",
      "bin/spark-update",
      "dist/spark-cli.js",
      "dist/spark-acp.js",
      "dist/spark-mcp.js",
      "dist/spark-update.js",
      "dist/migrations/0001_initial.sql",
      "skills/spark-cue/SKILL.md",
      "build/handler.js",
    ],
  },
  cli: {
    required: [
      "bin/spark",
      "bin/spark-acp",
      "bin/spark-daemon",
      "bin/spark-hub",
      "bin/spark-mcp",
      "bin/spark-tui",
      "bin/spark-update",
      "dist/spark-cli.js",
      "dist/spark-acp.js",
      "dist/spark-mcp.js",
      "dist/spark-update.js",
      "dist/build-info.json",
      "dist/migrations/0001_initial.sql",
      "skills/spark-cue/SKILL.md",
    ],
    forbidden: [
      "dist/spark-daemon.js",
      "dist/spark-hub.js",
      "dist/spark-tui.js",
      "build/handler.js",
    ],
  },
  daemon: {
    required: [
      "bin/spark-daemon",
      "dist/spark-daemon.js",
      "dist/spark-headless-role-executor.js",
      "dist/build-info.json",
      "dist/migrations/0001_initial.sql",
      "skills/spark-cue/SKILL.md",
    ],
    forbidden: [
      "bin/spark",
      "bin/spark-hub",
      "bin/spark-tui",
      "dist/spark-cli.js",
      "dist/spark-hub.js",
      "dist/spark-tui.js",
      "build/handler.js",
    ],
  },
  tui: {
    required: [
      "bin/spark-tui",
      "dist/spark-tui.js",
      "dist/build-info.json",
      "skills/spark-cue/SKILL.md",
    ],
    forbidden: [
      "bin/spark",
      "bin/spark-daemon",
      "bin/spark-hub",
      "dist/spark-cli.js",
      "dist/spark-daemon.js",
      "dist/spark-hub.js",
      "build/handler.js",
    ],
  },
  hub: {
    required: [
      "bin/spark-hub",
      "dist/spark-hub.js",
      "dist/spark-hub-server.js",
      "dist/spark-hub-web-service.js",
      "dist/build-info.json",
      "dist/migrations/0001_initial.sql",
      "build/handler.js",
    ],
    forbidden: [
      "bin/spark",
      "bin/spark-daemon",
      "bin/spark-tui",
      "dist/spark-cli.js",
      "dist/spark-daemon.js",
      "dist/spark-tui.js",
      "skills/spark-cue/SKILL.md",
    ],
  },
};

for (const product of npmDistributions) {
  const manifestPath = resolve(product.directory, "package.json");
  if (!(await exists(manifestPath))) continue;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.name !== product.packageName) {
    failures.push(`${product.id} product name must be ${product.packageName}`);
  }
  if (manifest.version !== releaseVersion) {
    failures.push(`${product.id} product version must match ${releaseVersion}`);
  }
  if (manifest.private === true) failures.push(`${product.id} npm product must be publishable`);
  const actualBins = Object.keys(manifest.bin ?? {}).sort();
  const expectedBins = Object.keys(product.bins).sort();
  if (JSON.stringify(actualBins) !== JSON.stringify(expectedBins)) {
    failures.push(
      `${product.id} product bins must be exactly ${expectedBins.join(", ")}; received ${actualBins.join(", ")}`,
    );
  }
  for (const name of expectedBins) {
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
  const discovered = await resolveProductRuntimeDependencies(root, product.directory);
  const expectedDependencies = sortedRecord({
    ...discovered,
    ...Object.fromEntries(product.exactDependencies.map((name) => [name, releaseVersion])),
  });
  if (
    JSON.stringify(sortedRecord(manifest.dependencies ?? {})) !==
    JSON.stringify(expectedDependencies)
  ) {
    failures.push(`${product.id} dependencies must match its generated runtime closure`);
  }
  if (
    Object.values(manifest.dependencies ?? {}).some((specifier) =>
      String(specifier).startsWith("workspace:"),
    )
  ) {
    failures.push(`${product.id} product must not expose workspace dependency protocols`);
  }
  const policy = assetPolicy[product.id];
  for (const asset of policy.required) {
    if (!(await exists(resolve(product.directory, asset)))) {
      failures.push(`${product.id} product is missing asset: ${asset}`);
    }
  }
  for (const asset of policy.forbidden) {
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
    buildInfo.version !== releaseVersion ||
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
for (const product of npmDistributions) {
  const manifestPath = resolve(product.directory, "package.json");
  if (!(await exists(manifestPath))) continue;
  built.push(
    `${product.id}: ${await countFiles(product.directory)} files; manifest ${(await stat(manifestPath)).size} bytes`,
  );
}
console.log(
  built.length
    ? `Npm distribution policy valid (${built.join("; ")}).`
    : `Npm distribution policy valid (${npmDistributions.length} public package identities configured).`,
);
