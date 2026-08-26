#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { nativeNpmDistributions, releaseDirectory, releaseVersion } from "./npm-distributions.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_NATIVE_ARCHIVE_BYTES = 2 * 1024 * 1024;

export async function buildNativeReleaseAssets(options = {}) {
  const version = options.version ?? releaseVersion;
  const configuredGitSha = options.gitSha ?? process.env.SPARK_BUILD_GIT_SHA?.trim();
  const gitSha =
    configuredGitSha ||
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const outputDirectory = resolve(options.outputDirectory ?? releaseDirectory);
  const nativeBinaryRoot = resolve(
    root,
    options.nativeBinaryRoot ?? process.env.SPARK_NATIVE_BIN_DIR ?? "dist/native",
  );
  const distributions = options.distributions ?? nativeNpmDistributions;
  const releaseBaseUrl =
    options.releaseBaseUrl ?? `https://github.com/zendev-lab/spark/releases/download/v${version}`;

  assertReleaseIdentity(version, gitSha);
  await mkdir(outputDirectory, { recursive: true });
  const targets = [];
  for (const distribution of distributions) {
    const binary = resolve(nativeBinaryRoot, distribution.target, "spark");
    const binaryMetadata = await stat(binary);
    if (!binaryMetadata.isFile()) throw new Error(`Native Spark binary is not a file: ${binary}`);
    await chmod(binary, 0o755);
    const asset = `spark-cli-${distribution.target}.tar.gz`;
    const assetPath = resolve(outputDirectory, asset);
    await execFileAsync("tar", ["-czf", assetPath, "-C", dirname(binary), "spark"], {
      cwd: root,
    });
    const archive = await readFile(assetPath);
    if (archive.byteLength > MAX_NATIVE_ARCHIVE_BYTES) {
      throw new Error(
        `${asset} is ${archive.byteLength} bytes; the limit is ${MAX_NATIVE_ARCHIVE_BYTES}`,
      );
    }
    targets.push({
      target: distribution.target,
      asset,
      size: archive.byteLength,
      sha256: sha256(archive),
    });
  }

  const installerPath = resolve(outputDirectory, "install.sh");
  await writeFile(
    installerPath,
    renderInstallScript({
      version,
      releaseBaseUrl,
      targets,
      requireHttps: options.requireHttps ?? releaseBaseUrl.startsWith("https://"),
    }),
    { mode: 0o755 },
  );
  await chmod(installerPath, 0o755);
  const installer = await readFile(installerPath);
  const manifest = {
    schemaVersion: 1,
    version,
    gitSha,
    targets,
    installer: {
      asset: "install.sh",
      size: installer.byteLength,
      sha256: sha256(installer),
    },
  };
  const manifestPath = resolve(outputDirectory, "native-release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const checksumNames = (await readdir(outputDirectory))
    .filter((name) => name !== "SHA256SUMS")
    .sort((left, right) => left.localeCompare(right));
  const checksumLines = [];
  for (const name of checksumNames) {
    const path = resolve(outputDirectory, name);
    const metadata = await stat(path);
    if (!metadata.isFile()) continue;
    checksumLines.push(`${sha256(await readFile(path))}  ${name}`);
  }
  await writeFile(resolve(outputDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`);
  return manifest;
}

export function renderInstallScript({ version, releaseBaseUrl, targets, requireHttps = true }) {
  assertReleaseIdentity(version, "0".repeat(40));
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("Installer requires at least one native target");
  }
  const targetCases = targets.map(
    ({ target, asset, sha256: expectedSha256 }) =>
      `  ${target}) asset=${shellQuote(asset)}; expected_sha256=${shellQuote(expectedSha256)} ;;`,
  );
  const curlCommand = requireHttps
    ? 'curl -fsSL --proto \'=https\' --tlsv1.2 "$asset_url" -o "$archive"'
    : 'curl -fsSL "$asset_url" -o "$archive"';
  return `${[
    "#!/bin/sh",
    "set -eu",
    "",
    `VERSION=${shellQuote(version)}`,
    `RELEASE_BASE_URL=${shellQuote(releaseBaseUrl)}`,
    "",
    "fail() {",
    "  printf '%s\\n' \"spark installer: $*\" >&2",
    "  exit 1",
    "}",
    "",
    "usage() {",
    "  printf '%s\\n' 'Install the exact Spark native bootstrap and managed npm payload.'",
    "  printf '%s\\n' 'Usage: install.sh [--prefix <absolute-path>]'",
    "  printf '%s\\n' 'Environment: SPARK_INSTALL_PREFIX overrides the default ~/.local prefix.'",
    "}",
    "",
    'prefix="${SPARK_INSTALL_PREFIX:-}"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    "    --help|-h) usage; exit 0 ;;",
    '    --prefix) [ "$#" -ge 2 ] || fail "--prefix requires a path"; prefix=$2; shift 2 ;;',
    '    *) fail "unknown option: $1" ;;',
    "  esac",
    "done",
    'if [ -z "$prefix" ]; then',
    '  [ -n "${HOME:-}" ] || fail "HOME is required when no install prefix is supplied"',
    '  prefix="$HOME/.local"',
    "fi",
    'case "$prefix" in /*) ;; *) fail "install prefix must be an absolute path: $prefix" ;; esac',
    "",
    'command -v node >/dev/null 2>&1 || fail "Node.js 24 or newer is required"',
    "node_major=$(node -p 'Number(process.versions.node.split(\".\")[0])' 2>/dev/null || true)",
    'case "$node_major" in ""|*[!0-9]*) fail "could not determine the Node.js version" ;; esac',
    '[ "$node_major" -ge 24 ] || fail "Node.js 24 or newer is required; found $(node --version 2>/dev/null || printf unknown)"',
    'command -v npm >/dev/null 2>&1 || fail "npm is required for the managed Spark payload"',
    'command -v curl >/dev/null 2>&1 || fail "curl is required to download Spark"',
    'command -v tar >/dev/null 2>&1 || fail "tar is required to unpack Spark"',
    "",
    'case "$(uname -s)/$(uname -m)" in',
    "  Darwin/arm64|Darwin/aarch64) target=aarch64-apple-darwin ;;",
    "  Linux/arm64|Linux/aarch64) target=aarch64-unknown-linux-musl ;;",
    "  Linux/x86_64|Linux/amd64) target=x86_64-unknown-linux-musl ;;",
    '  *) fail "unsupported platform: $(uname -s)/$(uname -m)" ;;',
    "esac",
    'case "$target" in',
    ...targetCases,
    '  *) fail "release has no native artifact for $target" ;;',
    "esac",
    "",
    'temp_root="${TMPDIR:-/tmp}"',
    'case "$temp_root" in /) temp_pattern=/spark-install.XXXXXX ;; *) temp_pattern="${temp_root%/}/spark-install.XXXXXX" ;; esac',
    'temp_dir=$(mktemp -d "$temp_pattern") || fail "could not create a temporary directory"',
    'case "$(basename "$temp_dir")" in spark-install.*) ;; *) fail "unexpected temporary directory: $temp_dir" ;; esac',
    "cleanup() {",
    '  if [ -n "${temp_dir:-}" ] && [ -d "$temp_dir" ]; then rm -rf -- "$temp_dir"; fi',
    "}",
    "trap cleanup EXIT HUP INT TERM",
    'archive="$temp_dir/$asset"',
    'asset_url="$RELEASE_BASE_URL/$asset"',
    curlCommand,
    "",
    "if command -v sha256sum >/dev/null 2>&1; then",
    '  checksum_line=$(sha256sum "$archive")',
    "elif command -v shasum >/dev/null 2>&1; then",
    '  checksum_line=$(shasum -a 256 "$archive")',
    "else",
    '  fail "sha256sum or shasum is required to verify Spark"',
    "fi",
    "actual_sha256=${checksum_line%% *}",
    '[ "$actual_sha256" = "$expected_sha256" ] || fail "checksum mismatch for $asset: expected $expected_sha256, received $actual_sha256"',
    'tar -xzf "$archive" -C "$temp_dir"',
    'native_cli="$temp_dir/spark"',
    '[ -f "$native_cli" ] || fail "native archive did not contain spark"',
    'chmod 755 "$native_cli"',
    '"$native_cli" install --managed --version "$VERSION" --prefix "$prefix"',
    "",
    'installed="$prefix/bin/spark"',
    '[ -x "$installed" ] || fail "managed installation did not create $installed"',
    'printf \'Spark %s installed at %s\\n\' "$VERSION" "$installed"',
    "resolved=$(command -v spark 2>/dev/null || true)",
    'if [ "$resolved" != "$installed" ]; then',
    "  printf 'Your shell currently resolves spark to %s. Put the managed prefix first:\\n' \"${resolved:-nothing}\"",
    '  printf \'  export PATH="%s/bin:$PATH"\\n\' "$prefix"',
    "fi",
    "",
  ].join("\n")}`;
}

function assertReleaseIdentity(version, gitSha) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid release version: ${JSON.stringify(version)}`);
  }
  if (!/^[a-f0-9]{40,64}$/u.test(gitSha)) {
    throw new Error(`Invalid release Git SHA: ${JSON.stringify(gitSha)}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildNativeReleaseAssets()));
}
