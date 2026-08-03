import { realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const cockpitDbEntry = realpathSync(
  fileURLToPath(import.meta.resolve("@zendev-lab/spark-cockpit-db")),
);
const migrationsSource = join(dirname(cockpitDbEntry), "migrations");
const migrationsDestination = fileURLToPath(new URL("../dist/migrations/", import.meta.url));

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
    "@ast-grep/napi",
    "ws",
    "@core-workspace/infoflow-sdk-nodejs",
    "@cursor/sdk",
    "axios",
    "protobufjs",
    "lodash.merge",
  ],
  format: "esm",
  outfile: "dist/cli.js",
  platform: "node",
  target: "node26",
});

await chmod("dist/cli.js", 0o755);
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
