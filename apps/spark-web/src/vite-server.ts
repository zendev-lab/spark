import { join } from "node:path";

import { createServer as createViteServer } from "vite";

import type { SparkWebDevelopmentServerOptions } from "./cli.ts";

export async function startSparkWebDevelopmentServer(
  options: SparkWebDevelopmentServerOptions,
): Promise<void> {
  const launchCwd = process.cwd();
  try {
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
    // SvelteKit resolves fallback components on later requests against cwd.
    // This dedicated web process must retain the app root for its lifetime.
  } catch (error) {
    process.chdir(launchCwd);
    throw error;
  }
}
