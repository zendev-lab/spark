#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productsDirectory = resolve(root, "dist/npm-products");
const releaseDirectory = resolve(root, "dist/release");
const rootManifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const prerelease = rootManifest.version.includes("-");

const distributions = [
  {
    id: "node",
    packageName: "@zendev-lab/spark",
    directory: resolve(productsDirectory, "node"),
    assetName: `spark-v${rootManifest.version}.tgz`,
    manifestName: "release-manifest.json",
  },
  {
    id: "hub",
    packageName: "@zendev-lab/spark-hub",
    directory: resolve(productsDirectory, "hub"),
    assetName: `spark-hub-v${rootManifest.version}.tgz`,
    manifestName: "hub-release-manifest.json",
  },
];

await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(releaseDirectory, { recursive: true });
await execFileAsync("node", ["scripts/build-npm-product.mjs"], {
  cwd: root,
  env: process.env,
  maxBuffer: 64 * 1024 * 1024,
});

const manifests = [];
for (const distribution of distributions) {
  const packedResult = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", releaseDirectory],
    {
      cwd: distribution.directory,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const packedMetadata = JSON.parse(packedResult.stdout)[0];
  if (
    packedMetadata?.name !== distribution.packageName ||
    packedMetadata?.version !== rootManifest.version
  ) {
    throw new Error(
      `Packed the wrong ${distribution.id} manifest: ${packedMetadata?.name ?? "unknown"}@${packedMetadata?.version ?? "unknown"}`,
    );
  }
  const reportedAsset = packedMetadata.filename;
  if (!reportedAsset) throw new Error(`npm did not report the ${distribution.id} tarball name`);
  await rename(
    resolve(releaseDirectory, reportedAsset),
    resolve(releaseDirectory, distribution.assetName),
  );
  const tarball = await readFile(resolve(releaseDirectory, distribution.assetName));
  const buildInfo = JSON.parse(
    await readFile(resolve(distribution.directory, "dist/build-info.json"), "utf8"),
  );
  const assetSha256 = createHash("sha256").update(tarball).digest("hex");
  const npmIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (packedMetadata.integrity !== npmIntegrity) {
    throw new Error(
      `${distribution.id} npm pack integrity ${packedMetadata.integrity ?? "missing"} does not match ${npmIntegrity}`,
    );
  }
  const manifest = {
    schemaVersion: 1,
    packageName: distribution.packageName,
    version: rootManifest.version,
    npmTag: prerelease ? "next" : "latest",
    npmIntegrity,
    assetName: distribution.assetName,
    assetSha256,
    gitSha: buildInfo.gitSha,
    buildFingerprint: buildInfo.fingerprint,
    minimumUpdaterVersion: rootManifest.sparkRelease.minimumUpdaterVersion,
    rollbackCompatibility: rootManifest.sparkRelease.rollbackCompatibility,
    migrationMode: rootManifest.sparkRelease.migrationMode,
  };
  await writeFile(
    resolve(releaseDirectory, distribution.manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  manifests.push({ distribution, manifest });
}

const tarballs = (await readdir(releaseDirectory)).filter((name) => name.endsWith(".tgz"));
if (tarballs.length !== distributions.length) {
  throw new Error(`Expected ${distributions.length} release tarballs, found ${tarballs.length}`);
}
await writeFile(
  resolve(releaseDirectory, "SHA256SUMS"),
  `${manifests
    .map(({ manifest }) => `${manifest.assetSha256}  ${manifest.assetName}`)
    .join("\n")}\n`,
);
console.log(
  JSON.stringify(Object.fromEntries(manifests.map(({ distribution, manifest }) => [distribution.id, manifest]))),
);
