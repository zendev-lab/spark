import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { test } from "vitest";

import { buildNativeReleaseAssets } from "../scripts/native-release-assets.mjs";

const execFileAsync = promisify(execFile);
const distributions = [
  { target: "aarch64-apple-darwin" },
  { target: "x86_64-apple-darwin" },
  { target: "aarch64-unknown-linux-musl" },
  { target: "x86_64-unknown-linux-musl" },
];

test("curl bootstrap pins, verifies, and delegates an exact managed install", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-native-installer-"));
  const nativeRoot = join(root, "native");
  const releaseRoot = join(root, "release");
  const record = join(root, "managed-install.args");
  const home = join(root, "home");
  const prefix = join(root, "custom-prefix");
  const conflictBin = join(root, "conflict", "bin");
  const fakeNative = `#!/bin/sh
set -eu
: "\${SPARK_INSTALL_RECORD:?}"
printf '%s\\n' "$@" > "$SPARK_INSTALL_RECORD"
prefix=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; shift 2; else shift; fi
done
[ -n "$prefix" ]
mkdir -p "$prefix/bin"
cp "$0" "$prefix/bin/spark"
chmod 755 "$prefix/bin/spark"
`;
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await Promise.all(
      distributions.map(async ({ target }) => {
        const directory = join(nativeRoot, target);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "spark"), fakeNative, { mode: 0o755 });
      }),
    );
    await mkdir(conflictBin, { recursive: true });
    await writeFile(join(conflictBin, "spark"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(join(conflictBin, "spark"), 0o755);

    server = createServer(async (request, response) => {
      const name = decodeURIComponent(
        new URL(request.url ?? "/", "http://fixture").pathname.slice(1),
      );
      try {
        const body = await readFile(join(releaseRoot, name));
        response.writeHead(200, { "content-length": String(body.byteLength) });
        response.end(body);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert(address && typeof address === "object");
    const manifest = await buildNativeReleaseAssets({
      version: "0.5.0",
      gitSha: "a".repeat(40),
      outputDirectory: releaseRoot,
      nativeBinaryRoot: nativeRoot,
      distributions,
      releaseBaseUrl: `http://127.0.0.1:${address.port}`,
      requireHttps: false,
    });

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.targets.length, 4);
    for (const entry of manifest.targets) {
      assert(entry.size > 0 && entry.size <= 2 * 1024 * 1024);
      assert.match(entry.sha256, /^[a-f0-9]{64}$/u);
      assert.equal((await stat(join(releaseRoot, entry.asset))).size, entry.size);
    }
    const sums = await readFile(join(releaseRoot, "SHA256SUMS"), "utf8");
    assert.match(sums, /  install\.sh$/mu);
    assert.match(sums, /  native-release-manifest\.json$/mu);

    const path = `${conflictBin}:${process.env.PATH ?? ""}`;
    const result = await execFileAsync(
      "sh",
      [join(releaseRoot, "install.sh"), "--prefix", prefix],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: path,
          SPARK_INSTALL_PREFIX: join(root, "environment-prefix"),
          SPARK_INSTALL_RECORD: record,
        },
      },
    );
    assert.deepEqual((await readFile(record, "utf8")).trim().split("\n"), [
      "install",
      "--managed",
      "--version",
      "0.5.0",
      "--prefix",
      prefix,
    ]);
    assert.match(result.stdout, /Spark 0\.5\.0 installed/u);
    assert.match(result.stdout, /Put the managed prefix first/u);
    assert.match(
      result.stdout,
      new RegExp(`export PATH="${escapeRegExp(prefix)}/bin:\\$PATH"`, "u"),
    );
    await stat(join(prefix, "bin", "spark"));

    const currentTarget = targetForCurrentPlatform();
    const currentAsset = manifest.targets.find((entry) => entry.target === currentTarget)?.asset;
    assert(currentAsset);
    await appendFile(join(releaseRoot, currentAsset), "tampered");
    await rm(record, { force: true });
    await assert.rejects(
      execFileAsync(
        "sh",
        [join(releaseRoot, "install.sh"), "--prefix", join(root, "checksum-prefix")],
        { env: { ...process.env, HOME: home, PATH: path, SPARK_INSTALL_RECORD: record } },
      ),
      (error: unknown) => commandError(error).includes("checksum mismatch"),
    );
    await assert.rejects(stat(record));

    const oldNodeBin = join(root, "old-node", "bin");
    await mkdir(oldNodeBin, { recursive: true });
    await writeFile(join(oldNodeBin, "node"), "#!/bin/sh\nprintf '23\\n'\n", { mode: 0o755 });
    await assert.rejects(
      execFileAsync("sh", [join(releaseRoot, "install.sh")], {
        env: { ...process.env, HOME: home, PATH: `${oldNodeBin}:${path}` },
      }),
      (error: unknown) => commandError(error).includes("Node.js 24 or newer is required"),
    );

    const unsupportedBin = join(root, "unsupported", "bin");
    await mkdir(unsupportedBin, { recursive: true });
    await writeFile(
      join(unsupportedBin, "uname"),
      "#!/bin/sh\ncase \"$1\" in -s) printf 'Plan9\\n' ;; -m) printf 'mips\\n' ;; esac\n",
      { mode: 0o755 },
    );
    await assert.rejects(
      execFileAsync("sh", [join(releaseRoot, "install.sh")], {
        env: { ...process.env, HOME: home, PATH: `${unsupportedBin}:${path}` },
      }),
      (error: unknown) => commandError(error).includes("unsupported platform: Plan9/mips"),
    );
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

function targetForCurrentPlatform(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "linux" && process.arch === "arm64") {
    return "aarch64-unknown-linux-musl";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "x86_64-unknown-linux-musl";
  }
  throw new Error(`unsupported test platform ${process.platform}/${process.arch}`);
}

function commandError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const stderr = "stderr" in error ? String(error.stderr) : "";
  return `${error.message}\n${stderr}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
