import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = mkdtempSync(join(tmpdir(), "spark-tui-vitest-home-"));
const sparkHome = join(root, "spark-home");
const configHome = join(root, "config");
const dataHome = join(root, "data");
const cacheHome = join(root, "cache");

for (const directory of [sparkHome, configHome, dataHome, cacheHome]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

// TUI tests must never discover or mutate the developer's Spark installation.
// Keep all implicit path resolution inside a worker-local temporary tree.
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.SPARK_HOME = sparkHome;
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_DATA_HOME = dataHome;
process.env.XDG_CACHE_HOME = cacheHome;

process.once("exit", () => {
  rmSync(root, { recursive: true, force: true });
});
