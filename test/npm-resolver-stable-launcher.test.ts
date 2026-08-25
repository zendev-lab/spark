import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const resolverUrl = new URL("../apps/spark-cli/src/npm-resolver.mjs", import.meta.url).href;

type StableLauncherState = {
  cliCommandPath?: string;
  stableLauncher?: string;
};

function configureStableLauncher(
  env: Record<string, string>,
  cliCommandPath: string,
): StableLauncherState {
  const program = `
    import { configureStableLauncher } from ${JSON.stringify(resolverUrl)};
    const env = ${JSON.stringify(env)};
    configureStableLauncher(env, ${JSON.stringify(cliCommandPath)});
    process.stdout.write(JSON.stringify({
      cliCommandPath: env.SPARK_CLI_COMMAND_PATH,
      stableLauncher: env.SPARK_STABLE_LAUNCHER,
    }));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
    }),
  ) as StableLauncherState;
}

describe("npm resolver stable launcher", () => {
  it("resolves the install-owner spark shim from PATH instead of the versioned resolver", () => {
    const root = mkdtempSync(join(tmpdir(), "spark-stable-launcher-"));
    try {
      const bin = join(root, "bin");
      const stableSpark = join(bin, "spark");
      mkdirSync(bin, { recursive: true });
      writeFileSync(stableSpark, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      expect(
        configureStableLauncher({ PATH: bin }, "/versioned/package/dist/npm-resolver.mjs"),
      ).toEqual({
        cliCommandPath: stableSpark,
        stableLauncher: stableSpark,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit managed stable launcher", () => {
    expect(
      configureStableLauncher(
        {
          PATH: "",
          SPARK_STABLE_LAUNCHER: "/managed/current/spark",
        },
        "/versioned/package/dist/npm-resolver.mjs",
      ),
    ).toEqual({
      cliCommandPath: "/versioned/package/dist/npm-resolver.mjs",
      stableLauncher: "/managed/current/spark",
    });
  });

  it("preserves an existing install-owner command path", () => {
    expect(
      configureStableLauncher(
        {
          PATH: "",
          SPARK_CLI_COMMAND_PATH: "/existing/bin/spark",
        },
        "/versioned/package/dist/npm-resolver.mjs",
      ),
    ).toEqual({
      cliCommandPath: "/existing/bin/spark",
      stableLauncher: "/existing/bin/spark",
    });
  });
});
