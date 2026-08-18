import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Foreground production Hub host (`spark hub` / `spark hub start`).
 * Mirrors package script `start:custom` without going through pnpm.
 */
export async function startHubProductionHost(args: string[] = []): Promise<number> {
  const packagedServerEntry = process.env.SPARK_HUB_SERVER_ENTRYPOINT?.trim();
  if (packagedServerEntry && existsSync(packagedServerEntry)) {
    return await runHubHost(
      process.execPath,
      [packagedServerEntry, ...args],
      dirname(packagedServerEntry),
    );
  }

  const handlerPath = join(appDir, "build", "handler.js");
  if (!existsSync(handlerPath)) {
    process.stderr.write(
      "Spark Hub production build not found. Build the app through its package script before starting it.\n",
    );
    return 1;
  }

  const tsx = join(appDir, "node_modules", ".bin", "tsx");
  const serverEntry = join(appDir, "server", "index.ts");
  return await runHubHost(tsx, [serverEntry, ...args], appDir);
}

async function runHubHost(command: string, args: string[], cwd: string): Promise<number> {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });

  return await new Promise<number>((resolveExit) => {
    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 0);
    });
  });
}
