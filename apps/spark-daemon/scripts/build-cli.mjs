import { realpathSync } from "node:fs";
import { chmod, cp, rm } from "node:fs/promises";
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
    js: "#!/usr/bin/env node",
  },
  bundle: true,
  entryPoints: ["src/cli.ts"],
  external: [
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
await rm(migrationsDestination, { recursive: true, force: true });
await cp(migrationsSource, migrationsDestination, { recursive: true });
