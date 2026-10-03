import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Isolate Spark tests and their child processes from the developer's runtime state. */
export function installHermeticSparkTestEnvironment(prefix: string): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const sparkHome = join(root, "spark-home");
  const configHome = join(root, "config");
  const dataHome = join(root, "data");
  const cacheHome = join(root, "cache");

  for (const directory of [sparkHome, configHome, dataHome, cacheHome]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.SPARK_HOME = sparkHome;
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_CACHE_HOME = cacheHome;

  // The npm launcher points this at its compiled executor artifact. A stale
  // developer-shell value would redirect tests outside the repository under test.
  delete process.env.SPARK_HEADLESS_EXECUTOR_MODULE;

  process.once("exit", () => {
    rmSync(root, { recursive: true, force: true });
  });
}
