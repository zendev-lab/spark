/**
 * `spark web` — temporary replacement for `dsh web`.
 *
 * Boots the DeepSeek Harness web profile through the installed `dsh` CLI,
 * with three spark-owned additions:
 *
 * 1. **spark-llm plugin, loaded automatically.** The Baidu OneAPI provider
 *    bundle is built from `@zendev-lab/spark-llm` (esbuild, host externals
 *    resolved by the DSH process) and placed under the profile's
 *    `plugins/spark-llm/`, then mounted through a generated patch overlay —
 *    no manual install or copy step.
 * 2. **Any bind host, including 0.0.0.0.** `dsh web` rejects `--host 0.0.0.0`
 *    outright for safety; the patch overlay restates the `webserver` row with
 *    the requested host instead. This is a deliberate bypass of that guard —
 *    a 0.0.0.0-bound harness exposes agent code execution to the network.
 * 3. **Host plugin HMR enabled**, so bundle replacements reload the affected
 *    plugin entry instead of requiring a restart.
 *
 * Everything else is forwarded to `dsh web` (ports, trusted hosts, app args).
 */
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural twin of the dispatcher launcher, declared here to keep this
 * module free of an import edge back into `cli.ts`.
 */
export interface SparkWebLauncher {
  run(target: string, argv: string[], options: { stdio: "inherit" }): Promise<number>;
}

/**
 * Locate a package root relative to this module's own location. Works both
 * from the source checkout (workspace node_modules links) and from the
 * publish bundle (whose node_modules carries the package), because it only
 * uses `import.meta.url` — esbuild replaces `import.meta.resolve` with a
 * dynamic require, which the publish bundle cannot provide.
 */
function resolvePackageDir(specifier: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgJson = resolveFromDirectory(here, specifier);
  if (pkgJson === undefined) {
    throw new Error(`spark web: cannot locate ${specifier} from ${here}`);
  }
  return dirname(pkgJson);
}

/**
 * Node-style upward `node_modules` lookup from one directory, used to find a
 * package installed into a DSH profile without `createRequire` (which the
 * publish esbuild bundle cannot provide).
 */
function resolveFromDirectory(dir: string, specifier: string): string | undefined {
  let current = dir;
  while (true) {
    const candidate = join(current, "node_modules", specifier, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface SparkWebArgs {
  host?: string;
  port?: number;
  trustedHosts: string[];
  argv: string[];
}

/** Parse `spark web` flags; everything unknown is forwarded to `dsh web`. */
export function parseSparkWebArgs(argv: readonly string[]): SparkWebArgs {
  const trustedHosts: string[] = [];
  const rest: string[] = [];
  let host: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--host") {
      host = argv[++index];
      if (host === undefined) throw new Error("spark web --host requires a value");
      continue;
    }
    if (arg.startsWith("--host=")) {
      host = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--port") {
      const raw = argv[++index];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error(`spark web --port must be a number, got ${JSON.stringify(raw)}`);
      }
      port = Number(raw);
      continue;
    }
    if (arg === "--trusted-host") {
      const value = argv[++index];
      if (value === undefined) throw new Error("spark web --trusted-host requires a value");
      trustedHosts.push(value);
      continue;
    }
    if (arg.startsWith("--trusted-host=")) {
      trustedHosts.push(arg.slice("--trusted-host=".length));
      continue;
    }
    rest.push(arg);
  }
  return { host, port, trustedHosts, argv: rest };
}

/** Resolve the DSH profile directory (`$DSH_HOME/profiles/web`). */
export function resolveDshProfileDir(
  dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh"),
): string {
  return join(dshHome, "profiles", "web");
}

/** Locate the installed `@zendev-lab/spark-llm` package root. */
export function resolveSparkLlmPackageDir(): string {
  return resolvePackageDir("@zendev-lab/spark-llm");
}

export interface SparkLlmBundleResult {
  entry: string;
  bundle: string;
  rebuilt: boolean;
}

/**
 * Build the spark-llm DSH plugin bundle into the profile's
 * `plugins/spark-llm/` directory (host externals stay external so the DSH
 * process resolves its own dsh-llm / pi-ai). Idempotent: rebuilds whenever
 * the plugin entry source is newer than the installed bundle.
 */
export async function ensureSparkLlmBundle(profileDir: string): Promise<SparkLlmBundleResult> {
  const llmDir = resolveSparkLlmPackageDir();
  const entry = join(llmDir, "src", "dsh-plugin.ts");
  if (!existsSync(entry))
    throw new Error(`spark web: spark-llm plugin entry not found at ${entry}`);
  const pluginDir = join(profileDir, "plugins", "spark-llm");
  mkdirSync(pluginDir, { recursive: true });
  const bundle = join(pluginDir, "dsh-plugin.mjs");
  const index = join(pluginDir, "index.mjs");
  let rebuilt = false;
  const sourceMtime = statSync(entry).mtimeMs;
  const bundleMtime = existsSync(bundle) ? statSync(bundle).mtimeMs : 0;
  if (bundleMtime < sourceMtime) {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      outfile: bundle,
      external: ["@deepseek-ai/*", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*"],
      logLevel: "silent",
    });
    rebuilt = true;
  }
  if (!existsSync(index)) {
    writeFileSync(
      index,
      '// Mount point for the spark-llm DSH plugin bundle, maintained by `spark web`.\nexport { default } from "./dsh-plugin.mjs";\n',
    );
  }
  return { entry, bundle, rebuilt };
}

const SPARK_WEB_DHS_PACKAGE = "@zendev-lab/spark-web-dsh";

/** Locate the installed `@zendev-lab/spark-web-dsh` package root. */
export function resolveSparkWebDshPackageDir(): string {
  const pkgJson = require.resolve(`${SPARK_WEB_DHS_PACKAGE}/package.json`);
  return dirname(pkgJson);
}


export interface SparkWebPatch {
  /** Patch rows: the spark-llm plugin insert and any overrides. */
  rows: string[];
  /** Path the patch overlay was written to. */
  path: string;
}

/**
 * Compose the patch overlay for one `spark web` run and write it to a
 * temporary file. Rows:
 *
 * - `spark-llm` host plugin (relative to the profile root, so the DSH loader
 *   resolves it without an install);
 * - `hmr` re-enabled (the web-app bundle ships it disabled);
 * - the `webserver` row restated with the requested host when it is not the
 *   DSH default — this is the documented way to bind 0.0.0.0, which the
 *   `dsh` CLI rejects outright.
 */
export interface SparkWebClientResult {
  packageDir: string;
  bundle: string;
  rebuilt: boolean;
  linked: boolean;
}

/**
 * Build the spark-web-dsh client bundle (when stale) and link the package
 * into the profile's node_modules so the DSH client-modules host can resolve
 * it as a `dsh.client` package. Idempotent on both halves.
 */
export async function ensureSparkWebClient(profileDir: string): Promise<SparkWebClientResult> {
  const packageDir = resolveSparkWebDshPackageDir();
  const entry = join(packageDir, "src", "client.tsx");
  const bundle = join(packageDir, "lib", "client.js");
  let rebuilt = false;
  if (
    existsSync(entry) &&
    (!existsSync(bundle) || statSync(entry).mtimeMs > statSync(bundle).mtimeMs)
  ) {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: "cjs",
      platform: "browser",
      jsx: "automatic",
      outfile: bundle,
      external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
      banner: {
        js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(SPARK_WEB_DHS_PACKAGE)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
      },
      footer: { js: "} });" },
      logLevel: "silent",
    });
    rebuilt = true;
  }
  let linked = false;
  try {
    if (resolveFromDirectory(profileDir, SPARK_WEB_DHS_PACKAGE) === undefined) throw new Error("not linked");
  } catch {
    const dsh = spawnSync("dsh", ["plugin", "--profile", "web", "add", `link:${packageDir}`], {
      stdio: "inherit",
    });
    if (dsh.status !== 0) {
      throw new Error(
        `spark web: failed to link ${SPARK_WEB_DHS_PACKAGE} into the DSH profile (dsh plugin add exited ${dsh.status ?? "with signal"})`,
      );
    }
    linked = true;
  }
  return { packageDir, bundle, rebuilt, linked };
}

/**
 * Compose the patch overlay for one `spark web` run and write it to a
 * temporary file. Rows:
 *
 * - `spark-llm` host plugin (relative to the profile root, so the DSH loader
 *   resolves it without an install);
 * - `spark-web-dsh` client plugin (package name; the client-modules host
 *   resolves it from the profile's node_modules and serves its bundle);
 * - `hmr` re-enabled (the web-app bundle ships it disabled);
 * - the `webserver` row restated with the requested host when it is not the
 *   DSH default — this is the documented way to bind 0.0.0.0, which the
 *   `dsh` CLI rejects outright.
 */

export function composeSparkWebPatch(profileDir: string, args: SparkWebArgs): SparkWebPatch {
  // The Loader rejects duplicate ids inside insert lists, so entries the
  // user profile already declares are skipped here (the patch layer only
  // adds what is missing).
  const userPatchPath = join(profileDir, "cordis.patch.yml");
  const userPatch = existsSync(userPatchPath) ? readFileSync(userPatchPath, "utf8") : "";
  const rows = ["- insert:"];
  if (!userPatch.includes("id: spark-llm")) {
    rows.push(
      "    # spark-llm Baidu OneAPI provider, loaded automatically by `spark web`.",
      "    - id: spark-llm",
      "      name: ./plugins/spark-llm/index.mjs",
    );
  }
  if (!userPatch.includes("id: spark-web-dsh")) {
    rows.push(
      "    - id: spark-web-dsh",
      `      name: ${JSON.stringify(SPARK_WEB_DHS_PACKAGE)}`,
    );
  }
  rows.push("- id: hmr", "  disabled: false");
  if (args.host !== undefined && args.host !== "127.0.0.1") {
    // Restating the row replaces its whole config, so the port keeps the
    // webStartup fallback (the `--port` flag still flows through it).
    rows.push(
      "- id: webserver",
      "  config:",
      `    host: ${args.host}`,
      "    port: !!js ctx.webStartup.port ?? 3080",
    );
  }
  const path = join(tmpdir(), `spark-web-patch-${process.pid}.yml`);
  writeFileSync(path, `${rows.join("\n")}\n`);
  return { rows, path };
}

/**
 * Prepare a `spark web` dispatch: ensure the spark-llm bundle, compose the
 * patch overlay, and return the `dsh web` argument list.
 */
export async function prepareSparkWebDispatch(args: SparkWebArgs): Promise<string[]> {
  const profileDir = resolveDshProfileDir();
  if (!existsSync(join(profileDir, "cordis.patch.yml"))) {
    throw new Error(
      `spark web: DSH profile not found at ${profileDir} — run "dsh web" once to initialize it first`,
    );
  }
  const bundle = await ensureSparkLlmBundle(profileDir);
  if (bundle.rebuilt) {
    process.stderr.write(`[spark web] built spark-llm plugin bundle -> ${bundle.bundle}\n`);
  }
  const client = await ensureSparkWebClient(profileDir);
  if (client.rebuilt) {
    process.stderr.write(`[spark web] built spark-web-dsh client bundle -> ${client.bundle}\n`);
  }
  if (client.linked) {
    process.stderr.write(`[spark web] linked ${SPARK_WEB_DHS_PACKAGE} into the DSH profile\n`);
  }

  const patch = composeSparkWebPatch(profileDir, args);
  const dshArgv = ["web", "--patch", patch.path];
  if (args.port !== undefined) dshArgv.push("--port", String(args.port));
  for (const trusted of args.trustedHosts) dshArgv.push("--trusted-host", trusted);
  dshArgv.push(...args.argv);
  return dshArgv;
}

/** Boot the DSH web profile through the dispatcher launcher. */
export async function runSparkWeb(args: SparkWebArgs, launcher: SparkWebLauncher): Promise<number> {
  const dshArgv = await prepareSparkWebDispatch(args);
  return launcher.run("web", dshArgv, { stdio: "inherit" });
}
