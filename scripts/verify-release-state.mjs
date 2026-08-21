#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  npmDistributions,
  nativeNpmDistributions,
  npmTag,
  releaseDirectory,
  releaseVersion,
} from "./npm-distributions.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

assertEqual(tag, expectedTag, "Git tag");
for (const release of releases) {
  verifyManifestIdentity(release);
  await verifyLocalArtifact(release.manifest);
}

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
  for (const release of releases) await verifyGithubAsset(githubRelease, release.manifest);
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

async function verifyGithubAsset(release, manifest) {
  const releaseAsset = release.assets?.find((asset) => asset.name === manifest.assetName);
  if (!releaseAsset?.url) {
    throw new Error(
      `Published GitHub Release ${release.tag_name} has no ${manifest.assetName} asset.`,
    );
  }
  const response = await githubFetch(releaseAsset.url, {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release asset download returned ${response.status}.`);
  }
  const publishedArtifact = Buffer.from(await response.arrayBuffer());
  const publishedSha256 = createHash("sha256").update(publishedArtifact).digest("hex");
  assertEqual(publishedSha256, manifest.assetSha256, `${manifest.packageName} GitHub asset SHA256`);
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
