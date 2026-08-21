#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  npmDistributions,
  nativeNpmDistributions,
  npmTag,
  releaseDirectory,
  releaseVersion,
} from "./npm-distributions.mjs";

const artifactOnly = process.argv.includes("--artifact-only");
const expectedTag = `v${releaseVersion}`;
const tag = process.env.GITHUB_REF_NAME?.trim() || expectedTag;
const gitSha = process.env.GITHUB_SHA?.trim();
const releases = await Promise.all(
  [...nativeNpmDistributions, ...npmDistributions].map(async (distribution) => ({
    ...distribution,
    manifest: await readJson(resolve(releaseDirectory, distribution.manifestName)),
  })),
);
const nativeRelease = await readJson(resolve(releaseDirectory, "native-release-manifest.json"));

assertEqual(tag, expectedTag, "Git tag");
for (const release of releases) {
  verifyManifestIdentity(release);
  await verifyLocalArtifact(release.manifest);
}
const releaseFiles = await verifyNativeRelease(nativeRelease);

if (artifactOnly) {
  console.log(
    `Verified ${releases.map((release) => release.assetName).join(", ")} for ${expectedTag}.`,
  );
  process.exit(0);
}

const npmState = Object.fromEntries(
  await Promise.all(
    releases.map(async (release) => [release.id, await verifyNpmState(release.manifest)]),
  ),
);
const githubRelease = await findGithubRelease(tag);
const githubPublished = githubRelease !== null && githubRelease.draft !== true;
const npmPublished = releases.every((release) => npmState[release.id] === true);

if (githubPublished && !npmPublished) {
  const missing = releases
    .filter((release) => npmState[release.id] !== true)
    .map((release) => release.packageName);
  throw new Error(`GitHub Release ${tag} is published, but npm is missing ${missing.join(", ")}.`);
}
if (githubPublished) {
  for (const file of releaseFiles) await verifyGithubFile(githubRelease, file);
  assertEqual(
    githubRelease.prerelease === true,
    releaseVersion.includes("-"),
    "GitHub prerelease state",
  );
}

const outputs = {
  github_published: githubPublished,
  github_release_exists: githubRelease !== null,
  npm_published: npmPublished,
  ...Object.fromEntries(
    releases.map((release) => [`npm_${release.id}_published`, npmState[release.id]]),
  ),
};
await writeOutputs(outputs);
console.log(
  JSON.stringify({
    tag,
    npm: npmState,
    githubReleaseExists: githubRelease !== null,
    githubPublished,
  }),
);

function verifyManifestIdentity(release) {
  const manifest = release.manifest;
  assertEqual(manifest.packageName, release.packageName, `${release.id} release package`);
  assertEqual(manifest.version, release.version ?? releaseVersion, `${release.id} release version`);
  assertEqual(manifest.assetName, release.assetName, `${release.id} release asset name`);
  if (!release.target) assertEqual(manifest.npmTag, npmTag, `${release.id} npm distribution tag`);
  if (release.target) assertEqual(manifest.target, release.target, `${release.id} native target`);
  if (gitSha) assertEqual(manifest.gitSha, gitSha, `${release.id} release Git SHA`);
}

async function verifyLocalArtifact(manifest) {
  const artifact = await readFile(resolve(releaseDirectory, manifest.assetName));
  const assetSha256 = createHash("sha256").update(artifact).digest("hex");
  const npmIntegrity = `sha512-${createHash("sha512").update(artifact).digest("base64")}`;
  assertEqual(manifest.assetSha256, assetSha256, `${manifest.packageName} asset SHA256`);
  assertEqual(manifest.npmIntegrity, npmIntegrity, `${manifest.packageName} npm integrity`);
}

async function verifyNativeRelease(manifest) {
  assertEqual(manifest.schemaVersion, 1, "native release schema");
  assertEqual(manifest.version, releaseVersion, "native release version");
  assertEqual(manifest.gitSha, releases[0]?.manifest.gitSha, "native release Git SHA");
  if (gitSha) assertEqual(manifest.gitSha, gitSha, "native release Git SHA");
  assertEqual(
    manifest.targets?.length,
    nativeNpmDistributions.length,
    "native release target count",
  );
  for (const distribution of nativeNpmDistributions) {
    const entry = manifest.targets?.find((candidate) => candidate.target === distribution.target);
    if (!entry) throw new Error(`Native release has no ${distribution.target} entry.`);
    assertEqual(
      entry.asset,
      `spark-cli-${distribution.target}.tar.gz`,
      `${distribution.target} asset name`,
    );
    await verifyNativeFile(entry);
    if (entry.size > 2 * 1024 * 1024) {
      throw new Error(`${entry.asset} exceeds the 2 MiB compressed size budget.`);
    }
  }
  assertEqual(manifest.installer?.asset, "install.sh", "native installer asset name");
  await verifyNativeFile(manifest.installer);
  const installer = await readFile(resolve(releaseDirectory, "install.sh"), "utf8");
  if (!installer.includes(`VERSION='${releaseVersion}'`)) {
    throw new Error("install.sh does not embed the exact release version.");
  }
  for (const entry of manifest.targets) {
    if (!installer.includes(entry.asset) || !installer.includes(entry.sha256)) {
      throw new Error(`install.sh does not pin ${entry.asset}.`);
    }
  }

  const names = (await readdir(releaseDirectory)).sort((left, right) => left.localeCompare(right));
  const checksums = parseChecksums(await readFile(resolve(releaseDirectory, "SHA256SUMS"), "utf8"));
  const expectedChecksumNames = names.filter((name) => name !== "SHA256SUMS");
  assertEqual(
    [...checksums.keys()].sort((left, right) => left.localeCompare(right)).join("\n"),
    expectedChecksumNames.join("\n"),
    "SHA256SUMS asset list",
  );
  const files = [];
  for (const name of names) {
    const path = resolve(releaseDirectory, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) continue;
    const digest = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    if (name !== "SHA256SUMS") {
      assertEqual(checksums.get(name), digest, `${name} SHA256SUMS entry`);
    }
    files.push({ asset: name, sha256: digest });
  }
  return files;
}

async function verifyNativeFile(entry) {
  const path = resolve(releaseDirectory, entry.asset);
  const metadata = await stat(path);
  assertEqual(metadata.size, entry.size, `${entry.asset} size`);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  assertEqual(digest, entry.sha256, `${entry.asset} SHA256`);
}

function parseChecksums(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/u).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/u);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${JSON.stringify(line)}`);
    entries.set(match[2], match[1]);
  }
  return entries;
}

async function verifyNpmState(manifest) {
  const packagePath = encodeURIComponent(manifest.packageName);
  const versionPath = encodeURIComponent(manifest.version);
  const response = await fetch(`https://registry.npmjs.org/${packagePath}/${versionPath}`, {
    headers: { accept: "application/json" },
  });
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} for ${manifest.packageName}.`);
  }
  const metadata = await response.json();
  assertEqual(
    metadata?.dist?.integrity,
    manifest.npmIntegrity,
    `${manifest.packageName} published npm integrity`,
  );
  return true;
}

async function findGithubRelease(releaseTag) {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) throw new Error("GITHUB_REPOSITORY is required to inspect release state.");
  const response = await githubFetch(
    `https://api.github.com/repos/${repository}/releases?per_page=100`,
  );
  if (!response.ok) {
    throw new Error(`GitHub Releases API returned ${response.status} for ${repository}.`);
  }
  const releaseEntries = await response.json();
  return releaseEntries.find((release) => release.tag_name === releaseTag) ?? null;
}

async function verifyGithubFile(release, file) {
  const releaseAsset = release.assets?.find((asset) => asset.name === file.asset);
  if (!releaseAsset?.url) {
    throw new Error(`Published GitHub Release ${release.tag_name} has no ${file.asset} asset.`);
  }
  const response = await githubFetch(releaseAsset.url, {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release asset download returned ${response.status}.`);
  }
  const publishedArtifact = Buffer.from(await response.arrayBuffer());
  const publishedSha256 = createHash("sha256").update(publishedArtifact).digest("hex");
  assertEqual(publishedSha256, file.sha256, `${file.asset} GitHub asset SHA256`);
}

async function githubFetch(url, options = {}) {
  const token = process.env.GITHUB_TOKEN?.trim();
  return await fetch(url, {
    ...options,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
}

async function writeOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}\n`);
  await appendFile(outputPath, lines.join(""));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
