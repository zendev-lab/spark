import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyDshPresetSources } from "../src/presets.ts";

const explicit = process.argv[2];
const packageDir =
  explicit === undefined
    ? resolve(dirname(fileURLToPath(import.meta.url)), "../presets/upstream-package")
    : resolve(explicit);
process.stdout.write(`${verifyDshPresetSources(packageDir)}\n`);
