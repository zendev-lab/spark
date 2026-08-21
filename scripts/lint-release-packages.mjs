import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { publint } from "publint";
import { formatMessage } from "publint/utils";

import {
  nativeNpmDistributions,
  npmDistributions,
  releaseDirectory,
} from "./npm-distributions.mjs";

let failed = false;

for (const distribution of [...nativeNpmDistributions, ...npmDistributions]) {
  const archivePath = resolve(releaseDirectory, distribution.assetName);
  const archive = await readFile(archivePath);
  const tarball = archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
  const result = await publint({ level: "error", pack: { tarball } });
  const errors = result.messages.filter((message) => message.type === "error");

  if (errors.length === 0) {
    // Preserve pack-release.mjs stdout as its machine-readable manifest JSON.
    console.error(`publint passed for ${distribution.packageName}`);
    continue;
  }

  failed = true;
  console.error(`publint found ${errors.length} error(s) in ${distribution.packageName}:`);
  for (const message of errors) console.error(formatMessage(message, result.pkg));
}

if (failed) throw new Error("publint rejected one or more release artifacts");
