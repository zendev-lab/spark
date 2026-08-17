import { realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const hubDbEntry = realpathSync(fileURLToPath(import.meta.resolve("@zendev-lab/spark-hub-db")));
const migrationsSource = join(dirname(hubDbEntry), "migrations");
const migrationsDestination = fileURLToPath(new URL("../dist/migrations/", import.meta.url));
const daemonMigrationSource = fileURLToPath(new URL("../src/store/migrations/", import.meta.url));
const daemonManifestSource = join(daemonMigrationSource, "manifest.json");
const daemonMigrationsDestination = fileURLToPath(
  new URL("../dist/migrations/daemon/", import.meta.url),
);

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
    "@ast-grep/napi",
    "ws",
    "@core-workspace/infoflow-sdk-nodejs",
    "axios",
    "protobufjs",
    "lodash.merge",
  ],
  format: "esm",
  outfile: temporaryCli,
  platform: "node",
  target: "node26",
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
const daemonManifest = JSON.parse(await readFile(daemonManifestSource, "utf8"));
const daemonMigrationNames = ["manifest.json", daemonManifest.baseline.checksumPath];
await mkdir(daemonMigrationsDestination, { recursive: true });
await Promise.all(
  daemonMigrationNames.map((name) =>
    copyFile(join(daemonMigrationSource, name), join(daemonMigrationsDestination, name)),
  ),
);
const staleDaemonMigrationNames = (await readdir(daemonMigrationsDestination)).filter(
  (name) => !daemonMigrationNames.includes(name),
);
await Promise.all(
  staleDaemonMigrationNames.map((name) =>
    rm(join(daemonMigrationsDestination, name), { recursive: true, force: true }),
  ),
);
await rm(fileURLToPath(new URL("../dist/daemon-migrations/", import.meta.url)), {
  recursive: true,
  force: true,
});
