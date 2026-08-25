import { realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const hubDbEntry = realpathSync(
  fileURLToPath(import.meta.resolve("@zendev-lab/spark-hub-storage-sqlite")),
);
const migrationsSource = join(dirname(hubDbEntry), "migrations");
const migrationsDestination = fileURLToPath(new URL("../dist/migrations/", import.meta.url));

const distCli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const temporaryCli = `${distCli}.${process.pid}.${Date.now()}.tmp`;

await build({
  banner: {
    // Some dependency-light tool paths still reach CommonJS packages such as
    // sanitize-html. Give esbuild's ESM require shim a Node-native resolver so
    // built daemon startup does not fail on their builtin dynamic requires.
    js: `#!/usr/bin/env node
import { createRequire as __sparkCreateRequire } from "node:module";
const require = __sparkCreateRequire(import.meta.url);`,
  },
  bundle: true,
  entryPoints: ["src/cli.ts"],
  external: [
    "@zendev-lab/cue",
    "@ast-grep/napi",
    "ws",
    "@core-workspace/infoflow-sdk-nodejs",
    "axios",
    "protobufjs",
    "lodash.merge",
    "sharp",
  ],
  format: "esm",
  outfile: temporaryCli,
  platform: "node",
  target: "node24",
});

await chmod(temporaryCli, 0o755);
await rename(temporaryCli, distCli);
await mkdir(migrationsDestination, { recursive: true });

const migrationNames = await readdir(migrationsSource);
await Promise.all(
  migrationNames.map((name) =>
    copyFile(join(migrationsSource, name), join(migrationsDestination, name)),
  ),
);

const staleMigrationNames = (await readdir(migrationsDestination)).filter(
  (name) => !migrationNames.includes(name),
);
await Promise.all(
  staleMigrationNames.map((name) =>
    rm(join(migrationsDestination, name), { recursive: true, force: true }),
  ),
);
