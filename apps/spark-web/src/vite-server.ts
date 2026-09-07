import { join } from "node:path";

import { createServer as createViteServer } from "vite";

import type { SparkWebDevelopmentServerOptions } from "./cli.ts";
import { SPARK_WEB_LAUNCH_CWD_ENV } from "./lib/server/launch-directory.ts";

export async function startSparkWebDevelopmentServer(
  options: SparkWebDevelopmentServerOptions,
): Promise<void> {
  const launchCwd = process.cwd();
  const previousLaunchCwd = process.env[SPARK_WEB_LAUNCH_CWD_ENV];
  try {
    process.env[SPARK_WEB_LAUNCH_CWD_ENV] = launchCwd;
    // SvelteKit route discovery and its watcher both resolve paths against cwd.
    process.chdir(options.appDir);
    const vite = await createViteServer({
      configFile: join(options.appDir, "vite.config.ts"),
      root: options.appDir,
      server: {
        host: options.host,
        port: options.port,
        strictPort: true,
        hmr: options.hmr,
        allowedHosts: ["127.0.0.1", "localhost"],
      },
    });
    await vite.listen();
  } catch (error) {
    process.chdir(launchCwd);
    if (previousLaunchCwd === undefined) delete process.env[SPARK_WEB_LAUNCH_CWD_ENV];
    else process.env[SPARK_WEB_LAUNCH_CWD_ENV] = previousLaunchCwd;
    throw error;
  }
}
