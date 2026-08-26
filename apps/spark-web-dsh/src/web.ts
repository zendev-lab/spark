/**
 * `spark web` — Spark-owned boot of the DeepSeek Harness web profile.
 *
 * The profile is booted directly: a plain `node` child imports the installed
 * `@deepseek-ai/dsh` package's `profile-boot-*` module and calls `runProfile`
 * — no `dsh` CLI on the PATH, no dsh-managed wrapper. On top of the stock
 * profile Spark owns nine additions:
 *
 * 1. **spark-llm plugin, loaded automatically.** The provider bundle is built
 *    from `@zendev-lab/spark-llm-providers` (esbuild, host externals resolved by the DSH
 *    process) and placed under the profile's `plugins/spark-llm/`, then mounted
 *    through a generated patch overlay. The overlay disables stock
 *    `llm-pi-ai` so Spark remains the only provider/configuration owner.
 * 2. **dsh-cue service and dsh-tool-cue adapter plus the managed spark-standard / spark-ptc
 *    presets and the package-owned cue Skill**, so Cue replaces DSH
 *    Bash/Pwsh/Jobs with canonical guidance and no manual setup. The preset
 *    compositions are static files versioned in this package
 *    (`presets/agent-presets/`); boot installs them into the DSH user preset
 *    root and retires a provably untouched legacy `spark-code` directory.
 * 3. **Spark file-tool plugin**, whose versioned read/write/edit operations
 *    shadow the upstream file mutations inside the managed presets.
 * 4. **dsh-tool-fusion plugin**, so the DSH-hosted web surface exposes the
 *    same bounded multi-model deliberation tool as daemon-hosted Spark.
 * 5. **dsh-tool-web and dsh-web-provider plugins**, so model-facing Web tools
 *    use the official `ctx.web` seam with Brave search, safe local fetch, and
 *    recoverable cached content instead of requiring a DeepSeek search service.
 * 6. **spark-session-subagent plugin**, Role-bound spawn/fork providers
 *    registered onto the official DSH HOST `ctx.subagents`. One-shot
 *    `start()` maps onto create then send. The overlay disables stock
 *    in-process spawn/fork backends so they do not steal those names.
 *    Daemon mounts the same providers.
 * 7. **spark-web-dsh client plugin**, linked from this application into the
 *    profile's node_modules so the onboarding flow offers Spark's provider
 *    selection step. Existing profiles that already declare
 *    `id: spark-web-dsh` skip a second insert.
 * 8. **Any bind host, including 0.0.0.0.** DSH always stays on a randomized
 *    loopback port guarded by a per-process credential. Spark's outer proxy
 *    owns the requested listener and applies the same Host, Origin, Fetch
 *    Metadata, and mutation-source checks for every bind (see `auth-proxy.ts`).
 *    Loopback peers stay tokenless; remote peers authenticate with daemon-user
 *    tokens.
 * 9. **Host plugin HMR disabled by default**, because this compatibility server
 *    prebuilds bundles and keeps long-lived reload state out of the process.
 *
 * Boot independence notes:
 *
 * - The child runs with `--expose-internals` so the cordis loader resolves
 *   bare plugin specifiers through Node's internal ESM loader. Its documented
 *   fallback, the `node-addon-require-builtin` native addon, breaks under
 *   pnpm store-link layouts (its optional platform package is unreachable
 *   from the loader's real location) and takes down every bare loader entry.
 * - Boot failures print the full AggregateError / cause chain; the loader's
 *   one-line summary names no failing entry and is not actionable.
 *
 * Everything else is forwarded to the web app (ports, trusted hosts, app
 * args).
 */
import { build } from "esbuild";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { cueSkillsRoot } from "@zendev-lab/cue";
import { startSparkWebDshAuthProxy } from "./auth-proxy.ts";
import { installManagedCuePresets, retireLegacyManagedCuePresets } from "./cue-presets.ts";
import { SPARK_WEB_DSH_PROXY_CREDENTIAL_KEY } from "./private-webserver.ts";

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
export function resolveFromDirectory(dir: string, specifier: string): string | undefined {
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
    if (arg.startsWith("--port=")) {
      const raw = arg.slice("--port=".length);
      if (!/^\d+$/.test(raw)) {
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
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new Error(`spark web --port must be between 1 and 65535, got ${port}`);
  }
  return { host, port, trustedHosts, argv: rest };
}

/** Resolve the DSH profile directory (`$DSH_HOME/profiles/web`). */
export function resolveDshProfileDir(
  dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh"),
): string {
  return join(dshHome, "profiles", "web");
}

/** Locate the installed `@zendev-lab/spark-llm-providers` package root. */
export function resolveSparkLlmPackageDir(): string {
  return resolvePackageDir("@zendev-lab/spark-llm-providers");
}

/** Locate the installed `@zendev-lab/spark-session` package root. */
export function resolveSparkSessionPackageDir(): string {
  return resolvePackageDir("@zendev-lab/spark-session");
}

/** Locate the installed `@zendev-lab/dsh-tool-cue` package root. */
export function resolveDshToolCuePackageDir(): string {
  return resolvePackageDir("@zendev-lab/dsh-tool-cue");
}

/** Locate the installed `@zendev-lab/dsh-cue` service package root. */
export function resolveDshCuePackageDir(): string {
  return resolvePackageDir("@zendev-lab/dsh-cue");
}

/** Locate the installed `@zendev-lab/dsh-tool-fusion` package root. */
export function resolveDshToolFusionPackageDir(): string {
  return resolvePackageDir("@zendev-lab/dsh-tool-fusion");
}

/** Locate the installed `@zendev-lab/dsh-tool-web` package root. */
export function resolveDshToolWebPackageDir(): string {
  return resolvePackageDir("@zendev-lab/dsh-tool-web");
}

/** Locate the Spark file owner whose DSH adapter is bundled into the profile. */
export function resolveSparkFilesPackageDir(): string {
  return resolvePackageDir("@zendev-lab/spark-files");
}

function packageRootFrom(start: string, expectedName: string): string | undefined {
  let current = start;
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
        if (metadata.name === expectedName) return current;
      } catch {
        // Keep walking: an unrelated or malformed package is not the DSH install.
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function executableOnPath(command: string): string | undefined {
  if (command.includes("/")) return existsSync(command) ? command : undefined;
  for (const entry of (process.env.PATH ?? "").split(":")) {
    const candidate = join(entry, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve the actual installed `@deepseek-ai/dsh` package owning the CLI. */
export function resolveInstalledDshPackageDir(
  command = process.env.SPARK_DSH_COMMAND?.trim() || "dsh",
  searchFrom = process.cwd(),
): string {
  const installed = resolveFromDirectory(searchFrom, "@deepseek-ai/dsh");
  if (installed !== undefined) return dirname(installed);
  const executable = executableOnPath(command);
  if (executable !== undefined) {
    const realExecutable = realpathSync(executable);
    const direct = packageRootFrom(dirname(realExecutable), "@deepseek-ai/dsh");
    if (direct !== undefined) return direct;
    const nested = resolveFromDirectory(dirname(realExecutable), "@deepseek-ai/dsh");
    if (nested !== undefined) return dirname(nested);
  }
  throw new Error(
    `spark web: cannot locate installed @deepseek-ai/dsh package metadata for ${JSON.stringify(command)}`,
  );
}

function hashSourceTree(paths: readonly string[]): string {
  const hash = createHash("sha256");
  const visit = (path: string, label: string): void => {
    const stats = statSync(path);
    if (stats.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (name === "node_modules" || name === "dist" || name === "lib") continue;
        visit(join(path, name), `${label}/${name}`);
      }
      return;
    }
    hash.update(label).update("\0").update(readFileSync(path)).update("\0");
  };
  paths.forEach((path, index) => visit(path, `source-${index}`));
  return hash.digest("hex");
}

export interface DshPluginBundleResult {
  entry: string;
  bundle: string;
  sourceDigest: string;
  rebuilt: boolean;
}

/** Build the credential-gated DSH WebServer adapter into the active profile. */
export async function ensureSparkPrivateWebServerBundle(profileDir: string): Promise<string> {
  const packageDir = resolveSparkWebDshPackageDir();
  const bundle = join(profileDir, "plugins", "spark-private-webserver", "index.mjs");
  mkdirSync(dirname(bundle), { recursive: true });
  await build({
    stdin: {
      contents: [
        'import WebServer from "@deepseek-ai/dsh-host-webserver";',
        'import { createSparkPrivateWebServerClass, takeSparkWebDshProxyCredential } from "./src/private-webserver.ts";',
        "export default createSparkPrivateWebServerClass(WebServer, takeSparkWebDshProxyCredential());",
      ].join("\n"),
      resolveDir: packageDir,
      sourcefile: "spark-private-webserver-entry.ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    outfile: bundle,
    external: ["@deepseek-ai/*"],
    logLevel: "silent",
  });
  return bundle;
}

interface DshToolBundleOptions {
  pluginName: string;
  packagedEntry: string;
  sourceEntry: string;
  sourcePaths: readonly string[];
  external: readonly string[];
}

async function ensureDshToolBundle(
  profileDir: string,
  options: DshToolBundleOptions,
): Promise<DshPluginBundleResult> {
  const packaged = existsSync(options.packagedEntry);
  const entry = packaged ? options.packagedEntry : options.sourceEntry;
  if (!existsSync(entry)) {
    throw new Error(`spark web: ${options.pluginName} plugin entry not found at ${entry}`);
  }
  const sourceDigest = hashSourceTree(packaged ? [entry] : options.sourcePaths);
  const pluginDir = join(profileDir, "plugins", options.pluginName);
  const bundle = join(pluginDir, "index.mjs");
  const digestPath = join(pluginDir, ".source-sha256");
  const previousDigest = existsSync(digestPath) ? readFileSync(digestPath, "utf8").trim() : "";
  const rebuilt = !existsSync(bundle) || previousDigest !== sourceDigest;
  if (rebuilt) {
    mkdirSync(pluginDir, { recursive: true });
    if (packaged) {
      writeFileSync(bundle, readFileSync(entry));
    } else {
      await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        outfile: bundle,
        external: [...options.external],
        logLevel: "silent",
      });
    }
    writeFileSync(digestPath, `${sourceDigest}\n`);
  }
  return { entry, bundle, sourceDigest, rebuilt };
}

/** Bundle the host-neutral Cue execution service into the DSH profile. */
export async function ensureDshCueBundle(profileDir: string): Promise<DshPluginBundleResult> {
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "dsh-cue.mjs");
  const packageDir = existsSync(packagedEntry) ? undefined : resolveDshCuePackageDir();
  const sourceEntry = packageDir ? join(packageDir, "src", "plugin.ts") : packagedEntry;
  return ensureDshToolBundle(profileDir, {
    pluginName: "dsh-cue",
    packagedEntry,
    sourceEntry,
    sourcePaths: packageDir
      ? [sourceEntry, join(packageDir, "package.json"), join(packageDir, "src")]
      : [packagedEntry],
    external: ["@deepseek-ai/*"],
  });
}

/** Bundle the supported DSH Cue tool adapter into the DSH profile. */
export async function ensureDshToolCueBundle(profileDir: string): Promise<DshPluginBundleResult> {
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "dsh-tool-cue.mjs");
  if (existsSync(packagedEntry)) {
    return ensureDshToolBundle(profileDir, {
      pluginName: "dsh-tool-cue",
      packagedEntry,
      sourceEntry: packagedEntry,
      sourcePaths: [packagedEntry],
      external: ["@deepseek-ai/*"],
    });
  }

  const packageDir = resolveDshToolCuePackageDir();
  const entry = join(packageDir, "src", "index.ts");
  return ensureDshToolBundle(profileDir, {
    pluginName: "dsh-tool-cue",
    packagedEntry,
    sourceEntry: entry,
    sourcePaths: [entry, join(packageDir, "package.json"), join(packageDir, "src")],
    external: ["@deepseek-ai/*"],
  });
}

/** Bundle the host-neutral Fusion tool into the DSH web profile. */
export async function ensureDshToolFusionBundle(
  profileDir: string,
): Promise<DshPluginBundleResult> {
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "dsh-tool-fusion.mjs");
  const packageDir = existsSync(packagedEntry) ? undefined : resolveDshToolFusionPackageDir();
  const sourceEntry = packageDir ? join(packageDir, "src", "extension.ts") : packagedEntry;
  return ensureDshToolBundle(profileDir, {
    pluginName: "dsh-tool-fusion",
    packagedEntry,
    sourceEntry,
    sourcePaths: packageDir
      ? [sourceEntry, join(packageDir, "package.json"), join(packageDir, "src")]
      : [packagedEntry],
    external: ["@deepseek-ai/*"],
  });
}

/** Bundle the per-agent Web tools into the DSH web profile. */
export async function ensureDshToolWebBundle(profileDir: string): Promise<DshPluginBundleResult> {
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "dsh-tool-web.mjs");
  const packageDir = existsSync(packagedEntry) ? undefined : resolveDshToolWebPackageDir();
  const sourceEntry = packageDir ? join(packageDir, "src", "index.ts") : packagedEntry;
  return ensureDshToolBundle(profileDir, {
    pluginName: "dsh-tool-web",
    packagedEntry,
    sourceEntry,
    sourcePaths: packageDir
      ? [sourceEntry, join(packageDir, "package.json"), join(packageDir, "src")]
      : [packagedEntry],
    external: ["@deepseek-ai/*"],
  });
}

/** Bundle the host-level Brave/local HTTP providers for the official ctx.web seam. */
export async function ensureDshWebProviderBundle(
  profileDir: string,
): Promise<DshPluginBundleResult> {
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "dsh-web-provider.mjs");
  const packageDir = existsSync(packagedEntry) ? undefined : resolveDshToolWebPackageDir();
  const sourceEntry = packageDir ? join(packageDir, "src", "provider.ts") : packagedEntry;
  return ensureDshToolBundle(profileDir, {
    pluginName: "dsh-web-provider",
    packagedEntry,
    sourceEntry,
    sourcePaths: packageDir
      ? [sourceEntry, join(packageDir, "package.json"), join(packageDir, "src")]
      : [packagedEntry],
    external: ["@deepseek-ai/*"],
  });
}

/** Install the Spark-owned, DSH-native versioned file tools into this profile. */
export async function ensureSparkFilesBundle(profileDir: string): Promise<DshPluginBundleResult> {
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "spark-files-dsh-plugin.mjs");
  const packageDir = existsSync(packagedEntry) ? undefined : resolveSparkFilesPackageDir();
  const sourceEntry = packageDir ? join(packageDir, "src", "dsh-plugin.ts") : packagedEntry;
  return ensureDshToolBundle(profileDir, {
    pluginName: "spark-files",
    packagedEntry,
    sourceEntry,
    sourcePaths: packageDir
      ? [sourceEntry, join(packageDir, "package.json"), join(packageDir, "src")]
      : [packagedEntry],
    external: ["@deepseek-ai/*"],
  });
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
  const packagedEntry = join(resolveSparkWebDshPackageDir(), "lib", "spark-llm-dsh-plugin.mjs");
  const entry = existsSync(packagedEntry)
    ? packagedEntry
    : join(resolveSparkLlmPackageDir(), "src", "dsh-plugin.ts");
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
    if (entry === packagedEntry) {
      writeFileSync(bundle, readFileSync(packagedEntry));
    } else {
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
    }
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

export interface SparkSessionSubagentBundleResult {
  entry: string;
  bundle: string;
  rebuilt: boolean;
}

/**
 * Build the spark-session-subagent DSH plugin into `plugins/spark-session-subagent/`.
 * Host externals stay external so the DSH process resolves cordis / dsh-session.
 */
export async function ensureSparkSessionSubagentBundle(
  profileDir: string,
): Promise<SparkSessionSubagentBundleResult> {
  const packagedEntry = join(
    resolveSparkWebDshPackageDir(),
    "lib",
    "spark-session-subagent-plugin.mjs",
  );
  const entry = existsSync(packagedEntry)
    ? packagedEntry
    : join(resolveSparkSessionPackageDir(), "src", "subagent.ts");
  if (!existsSync(entry)) {
    throw new Error(`spark web: spark-session-subagent plugin entry not found at ${entry}`);
  }
  const pluginDir = join(profileDir, "plugins", "spark-session-subagent");
  mkdirSync(pluginDir, { recursive: true });
  const bundle = join(pluginDir, "index.mjs");
  let rebuilt = false;
  const sourceMtime = statSync(entry).mtimeMs;
  const bundleMtime = existsSync(bundle) ? statSync(bundle).mtimeMs : 0;
  if (bundleMtime < sourceMtime) {
    if (entry === packagedEntry) {
      writeFileSync(bundle, readFileSync(packagedEntry));
    } else {
      await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node22",
        outfile: bundle,
        external: ["@deepseek-ai/*"],
        logLevel: "silent",
      });
    }
    rebuilt = true;
  }
  return { entry, bundle, rebuilt };
}

const SPARK_WEB_DHS_PACKAGE = "@zendev-lab/spark-web-dsh";
const SPARK_WEB_PACKAGE = "@zendev-lab/spark-web-dsh";

/** Locate this application's package root (the DSH client plugin lives here). */
export function resolveSparkWebDshPackageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = packageRootFrom(here, SPARK_WEB_PACKAGE);
  if (root === undefined) {
    throw new Error(`spark web: cannot locate ${SPARK_WEB_PACKAGE} from ${here}`);
  }
  return root;
}

/** Resolve the canonical Cue Skill from its exact package dependency. */
export function resolveCueSkillsDir(explicitRoot: string = cueSkillsRoot): string {
  const root = resolve(explicitRoot);
  try {
    const skillFile = lstatSync(join(root, "cue", "SKILL.md"));
    if (skillFile.isFile() && !skillFile.isSymbolicLink()) return root;
  } catch {
    // Report the package or explicit override path below.
  }
  throw new Error(`spark web: cannot locate the package-owned Cue Skill under ${root}`);
}

export interface SparkWebPatch {
  /** Patch rows: spark plugin inserts, the preset default, and overrides. */
  rows: string[];
  /** Path the patch overlay was written to. */
  path: string;
}

export interface SparkWebClientResult {
  packageDir: string;
  bundle: string;
  rebuilt: boolean;
  linked: boolean;
}

/**
 * Build the spark-web-dsh host and client bundles, then link the package into
 * the profile. The host owns the temporary cold-history safety fence; the
 * client owns onboarding and remote-HTTP compatibility.
 */
export async function ensureSparkWebClient(profileDir: string): Promise<SparkWebClientResult> {
  const packageDir = resolveSparkWebDshPackageDir();
  const entry = join(packageDir, "src", "client.tsx");
  const bundle = join(packageDir, "lib", "client.js");
  const hostEntry = join(packageDir, "src", "index.ts");
  const hostBundle = join(packageDir, "lib", "index.js");
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
      footer: {
        js: `module.exports = { default: { name, inject, apply }, name, inject, apply };
return module.exports;
}
});`,
      },
      logLevel: "silent",
    });
    rebuilt = true;
  }
  // Always rebuild the tiny host half. Git checkout mtimes cannot prove that
  // a tracked/generated lib artifact matches this source revision.
  if (existsSync(hostEntry)) {
    await build({
      entryPoints: [hostEntry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      outfile: hostBundle,
      logLevel: "silent",
    });
    rebuilt = true;
  }

  let linked = false;
  const before = resolveFromDirectory(profileDir, SPARK_WEB_DHS_PACKAGE);
  const beforeReal = before === undefined ? undefined : realpathSync(dirname(before));
  linkClientIntoProfile(profileDir, packageDir);
  if (beforeReal !== realpathSync(packageDir)) linked = true;
  return { packageDir, bundle, rebuilt, linked };
}

/**
 * Link a workspace package into a DSH profile's node_modules with a plain
 * directory symlink (equivalent to `dsh plugin add link:<dir>`), so booting
 * never needs the external `dsh` CLI on the PATH.
 */
function linkClientIntoProfile(profileDir: string, packageDir: string): void {
  // Early builds nested the scope directory twice
  // (`@zendev-lab/@zendev-lab/spark-web-dsh`); that link is invisible to
  // package resolution. Remove it idempotently so stale profiles heal.
  const legacyScope = join(profileDir, "node_modules", "@zendev-lab", "@zendev-lab");
  const legacyLink = join(legacyScope, "spark-web-dsh");
  if (existsSync(legacyLink) && lstatSync(legacyLink).isSymbolicLink()) {
    unlinkSync(legacyLink);
    if (readdirSync(legacyScope).length === 0) rmdirSync(legacyScope);
  }
  const target = join(profileDir, "node_modules", SPARK_WEB_DHS_PACKAGE);
  mkdirSync(dirname(target), { recursive: true });
  const targetStat = lstatSync(target, { throwIfNoEntry: false });
  if (targetStat !== undefined) {
    if (!targetStat.isSymbolicLink()) {
      throw new Error(`spark web: ${target} exists and is not a symlink`);
    }
    // The profile may still point at an older checkout or a package path that
    // no longer exists. Re-link both stale and dangling symlinks.
    if (existsSync(target) && realpathSync(target) === realpathSync(packageDir)) return;
    unlinkSync(target);
  }
  symlinkSync(packageDir, target, "junction");
}

/**
 * Flatten one boot failure into printable lines: AggregateError inner errors
 * and `cause` chains, depth-capped and total-bounded so a loader blowup stays
 * readable. The generated boot script embeds this exact implementation via
 * `Function#toString`, so the child process and the unit tests run one and
 * the same code. Keep it self-contained: no module-scope references.
 */
export function sparkWebBootErrorLines(error: unknown, limit = 40): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>();
  const visit = (failure: unknown, depth: number): void => {
    if (lines.length >= limit || seen.has(failure)) return;
    seen.add(failure);
    lines.push(
      `${"  ".repeat(Math.min(depth, 6))}${failure instanceof Error ? failure.message : String(failure)}`,
    );
    if (failure instanceof AggregateError) {
      for (const inner of failure.errors) visit(inner, depth + 1);
    }
    if (failure instanceof Error && failure.cause !== undefined) visit(failure.cause, depth + 1);
  };
  visit(error, 0);
  if (lines.length >= limit) lines.push("… (further nested failures truncated)");
  return lines;
}

/**
 * A boot script that starts the DSH web profile **without the `dsh` CLI**:
 * it locates the installed `@deepseek-ai/dsh` package, imports its
 * `profile-boot-*.js` entry (the module the `dsh` binary runs) and invokes
 * `runProfile` directly. The script lives inside the profile so its bare
 * imports (`@deepseek-ai/dsh-app-boot`, ...) resolve from the profile's
 * node_modules. It is always spawned through `process.execPath`, so the PATH
 * never needs to contain `dsh`.
 */
export function sparkWebBootScript(
  patchFiles: readonly string[],
  webArgs: readonly string[],
): string {
  const lines = [
    "// Generated by spark web — boots the DSH web profile without the dsh CLI.",
    'import { readFileSync, readdirSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";',
    "",
    `const patchFiles = [${patchFiles.map((file) => JSON.stringify(file)).join(", ")}];`,
    `const webArgs = [${webArgs.map((arg) => JSON.stringify(arg)).join(", ")}];`,
    'const proxyCredential = readFileSync(3, "utf8");',
    'if (proxyCredential.length < 32) throw new Error("spark web: private proxy credential is unavailable");',
    `Reflect.set(globalThis, Symbol.for(${JSON.stringify(SPARK_WEB_DSH_PROXY_CREDENTIAL_KEY)}), proxyCredential);`,
    "",
    "const dshPackageDir = process.argv[2];",
    'const libDir = join(dshPackageDir, "lib");',
    "// Sorted: the package ships a re-export shim next to the real module (both",
    "// export runProfile); a deterministic pick keeps boots reproducible.",
    "const entry = readdirSync(libDir)",
    '  .filter((file) => file.startsWith("profile-boot-") && file.endsWith(".js"))',
    "  .sort()[0];",
    "if (entry === undefined) {",
    "  throw new Error(`spark web: no profile-boot module found under ${libDir}`);",
    "}",
    "const { runProfile } = await import(pathToFileURL(join(libDir, entry)).href);",
    "",
    `const sparkWebBootErrorLines = ${sparkWebBootErrorLines.toString()};`,
    "",
    "try {",
    "  await runProfile({",
    '    environment: loadLayeredEnv("spark"),',
    '    profile: "web",',
    "    patchFiles,",
    "    args: webArgs,",
    "  });",
    "} catch (error) {",
    "  let deepest = error;",
    "  while (deepest instanceof Error && deepest.cause !== undefined) deepest = deepest.cause;",
    '  if (deepest instanceof Error && deepest.code === "EADDRINUSE") {',
    '    const target = /address already in use (.+)/.exec(deepest.message ?? "")?.[1];',
    "    console.error(target === undefined",
    '      ? "spark web: cannot start the web server because its port is already in use."',
    "      : `spark web: cannot start the web server — ${target} is already in use.`);",
    '    console.error("spark web: pick a free port with --port <port> (default 3080 is taken by a running harness).");',
    "    process.exitCode = 1;",
    "  } else {",
    "    // Loader failures arrive as an AggregateError whose top-level message",
    "    // names no failing entry; print the whole chain so the report is actionable.",
    '    console.error("spark web: server failed to start; failure chain:");',
    "    for (const line of sparkWebBootErrorLines(error)) {",
    "      console.error(`spark web:   ${line}`);",
    "    }",
    "    process.exitCode = 1;",
    "  }",
    "}",
  ];
  return lines.join("\n");
}

/** The `dsh` package directory a profile's node_modules can resolve. */
export function resolveDshPackageDir(profileDir: string): string {
  const pkgJson = resolveFromDirectory(profileDir, "@deepseek-ai/dsh");
  if (pkgJson === undefined) {
    throw new Error(`spark web: cannot locate @deepseek-ai/dsh from ${profileDir}`);
  }
  return dirname(pkgJson);
}

/**
 * Process arguments for the boot child. `--expose-internals` is the cordis
 * loader's first-class path for resolving bare plugin specifiers: it uses
 * Node's internal ESM loader instead of the optional
 * `node-addon-require-builtin` native addon, whose platform binding is not
 * reliably resolvable under pnpm store-link layouts (without it, every bare
 * loader entry fails inside one opaque AggregateError). The child is the DSH
 * host process itself, which the loader already expects to run this way.
 */
export function sparkWebBootNodeArgs(scriptPath: string, dshPackageDir: string): string[] {
  return ["--expose-internals", scriptPath, dshPackageDir];
}

/** Spawn the DSH web profile through bare node running the boot script. */
export async function runSparkWebDirect(
  profileDir: string,
  patches: readonly string[],
  webArgs: readonly string[],
  proxyCredential: string,
): Promise<number> {
  const dshPackageDir = resolveDshPackageDir(profileDir);
  const scriptPath = join(profileDir, "plugins", "spark-web-boot.mjs");
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, sparkWebBootScript(patches, webArgs));
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, sparkWebBootNodeArgs(scriptPath, dshPackageDir), {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
    });
    const credentialPipe = child.stdio[3] as Writable | null;
    credentialPipe?.on("error", () => {});
    credentialPipe?.end(proxyCredential);
    child.on("error", (error: NodeJS.ErrnoException) => {
      const detail = error.code === "ENOENT" ? "node was not found" : error.message;
      process.stderr.write(`spark web: failed to start the web server: ${detail}\n`);
      resolve(error.code === "ENOENT" ? 127 : 1);
    });
    child.on("close", (code, signal) => {
      if (signal) {
        process.stderr.write(`spark web: server stopped by ${signal}\n`);
        resolve(160);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * Compose the patch overlay for one `spark web` run and write it to a
 * temporary file. Rows:
 *
 * - `spark-llm`, `dsh-cue`, `dsh-tool-cue`, `dsh-tool-fusion`,
 *   `dsh-web-provider`, and `spark-session-subagent` host plugins
 *   (paths relative to the profile root, so the DSH loader resolves them
 *   without an install);
 * - stock `llm-pi-ai` disabled so `spark-llm-providers` owns provider configuration and
 *   credentials without a competing configurable-provider directory;
 * - stock in-process spawn/fork backends disabled so Spark providers own those
 *   names on the official HOST;
 * - `spark-web-dsh` client plugin (package name; the client-modules host
 *   resolves it from the profile's node_modules and serves its bundle);
 * - `agent-presets` defaulting to spark-standard (the supported DSH release
 *   force-appends its shipped preset root at boot, so the roster's roots are
 *   not overlay-configurable);
 * - HMR remains disabled for the long-lived compatibility server (the command
 *   builds bundles before boot, and HMR retains reload state across sessions);
 * - the `webserver` row pinned to loopback so an existing profile cannot expose
 *   the private target port outside Spark's proxy.
 */
export function composeSparkWebPatch(profileDir: string): SparkWebPatch {
  // The Loader rejects duplicate ids inside insert lists, so entries the
  // user profile already declares are skipped here (the patch layer only
  // adds what is missing).
  const userPatchPath = join(profileDir, "cordis.patch.yml");
  const userPatch = existsSync(userPatchPath) ? readFileSync(userPatchPath, "utf8") : "";
  const rows = [
    "- insert:",
    "    # Process-private DSH carrier; only Spark's outer proxy has its credential.",
    "    - id: spark-private-webserver",
    "      name: ./plugins/spark-private-webserver/index.mjs",
    "      inject: [webStartup]",
    "      config:",
    "        host: 127.0.0.1",
    "        port: !!js ctx.webStartup.port ?? 3080",
  ];
  if (!userPatch.includes("id: spark-llm")) {
    rows.push(
      "    # Spark-owned LLM providers, loaded automatically by `spark web`.",
      "    - id: spark-llm",
      "      name: ./plugins/spark-llm/index.mjs",
    );
  }
  if (!userPatch.includes("id: dsh-cue")) {
    rows.push(
      "    # Host-neutral Cue execution service, managed by `spark web`.",
      "    - id: dsh-cue",
      "      name: ./plugins/dsh-cue/index.mjs",
    );
  }
  if (!userPatch.includes("id: dsh-tool-cue")) {
    rows.push(
      "    # Cue-first command, script, job, and scope tools, managed by `spark web`.",
      "    - id: dsh-tool-cue",
      "      name: ./plugins/dsh-tool-cue/index.mjs",
    );
  }
  if (!userPatch.includes("id: dsh-tool-fusion")) {
    rows.push(
      "    # Bounded multi-model deliberation, managed by `spark web`.",
      "    - id: dsh-tool-fusion",
      "      name: ./plugins/dsh-tool-fusion/index.mjs",
    );
  }
  if (!userPatch.includes("id: dsh-web-provider")) {
    rows.push(
      "    # Provider-neutral Brave search and safe local fetch on ctx.web.",
      "    - id: dsh-web-provider",
      "      name: ./plugins/dsh-web-provider/index.mjs",
    );
  }
  if (!userPatch.includes("id: spark-session-subagent")) {
    rows.push(
      "    # Spark Role-bound spawn/fork providers on the official HOST.",
      "    - id: spark-session-subagent",
      "      name: ./plugins/spark-session-subagent/index.mjs",
    );
  }
  if (!userPatch.includes("@deepseek-ai/dsh-tool-fs")) {
    rows.push(
      "    # Keep upstream read_image globally; Spark presets shadow read/write/edit.",
      "    - id: spark-base-tool-fs",
      "      name: '@deepseek-ai/dsh-tool-fs'",
    );
  }
  if (!userPatch.includes("id: spark-web-dsh")) {
    rows.push("    - id: spark-web-dsh", `      name: ${JSON.stringify(SPARK_WEB_DHS_PACKAGE)}`);
  }
  if (!userPatch.includes("id: agent-presets")) {
    // The supported DSH release's boot force-appends its shipped preset root
    // after every overlay, so a `roots` override here would be inert, and
    // `includeUserRoot: false` would hide the user root that carries the
    // managed Spark presets. Spark therefore sets only the default; an
    // exclusive roster would need a DSH release with deployment-configurable
    // roots.
    rows.push("- id: agent-presets", "  config:", "    default: spark-standard");
  }
  rows.push(
    "- id: session-persistence-jsonl",
    "  config:",
    "    root: !!js dshHomePath('sessions')",
    "    preparedSessionCacheSize: 1",
  );
  rows.push(
    "- id: llm-pi-ai",
    "  disabled: true",
    "- id: subagent-spawn-in-process",
    "  disabled: true",
    "- id: subagent-fork-in-process",
    "  disabled: true",
  );
  rows.push("- id: hmr", "  disabled: true");
  // Disable the stock carrier by exact name, so upstream drift fails closed
  // instead of silently leaving an unguarded listener beside Spark's service.
  rows.push("- id: webserver", "  name: '@deepseek-ai/dsh-host-webserver'", "  disabled: true");
  const path = join(tmpdir(), `spark-web-patch-${process.pid}.yml`);
  writeFileSync(path, `${rows.join("\n")}\n`);
  return { rows, path };
}

/** Compose the arguments handed to the web app after the patch overlays. */
/** True when nothing is bound to `port` on the loopback interface. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => probe.close(() => resolve(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/**
 * The next free port at or above `preferred`. The DSH web server defaults to
 * 3080, which an already-running harness keeps occupied; `spark web` then
 * shifts to the first free port so a plain `spark web` invocation always
 * works on the developer machine.
 */
export async function nextFreeWebPort(
  preferred = 3080,
  attempts = 100,
  excluded: readonly number[] = [],
): Promise<number> {
  const last = Math.min(65_535, preferred + attempts - 1);
  for (let port = preferred; port <= last; port++) {
    if (!excluded.includes(port) && (await isPortFree(port))) return port;
  }
  throw new Error(`spark web: no free port found from ${preferred} to ${last}`);
}

export function composeWebArgs(args: SparkWebArgs, port = args.port ?? 3080): string[] {
  const webArgs = [`--port=${port}`, "--no-open"];
  for (const trusted of args.trustedHosts) webArgs.push(`--trusted-host=${trusted}`);
  webArgs.push(...args.argv);
  return webArgs;
}

/**
 * Prepare a `spark web` dispatch: ensure the managed DSH and Spark host plugin
 * bundles, compose the patch overlay, and return the `dsh web` argument list.
 */
export interface SparkWebDispatch {
  /** The DSH profile the web server will be booted from. */
  profileDir: string;
  /** Patch overlay files for the managed host and client plugin rows. */
  patches: string[];
  /** Arguments passed to the web app after the patch overlays. */
  webArgs: string[];
  /** Outer Spark trust boundary and private DSH loopback target. */
  proxy: { host: string; port: number; targetPort: number; credential: string };
}

export async function prepareSparkWebDispatch(
  args: SparkWebArgs,
  profileDir: string = resolveDshProfileDir(),
): Promise<SparkWebDispatch> {
  const dshHome = dirname(dirname(profileDir));
  if (!existsSync(join(profileDir, "cordis.patch.yml"))) {
    throw new Error(
      `spark web: DSH profile not found at ${profileDir} — run "dsh web" once to initialize it first`,
    );
  }
  const dshPackageDir = resolveInstalledDshPackageDir(undefined, profileDir);
  // Metadata and preset-source verification happen before any managed write.
  const skillDir = resolveCueSkillsDir();
  const presets = installManagedCuePresets(dshHome, dshPackageDir, skillDir);
  const retiredPresets = retireLegacyManagedCuePresets(dshHome);
  const files = await ensureSparkFilesBundle(profileDir);
  if (files.rebuilt) {
    process.stderr.write(`[spark web] built Spark file plugin bundle -> ${files.bundle}\n`);
  }
  await ensureSparkPrivateWebServerBundle(profileDir);
  for (const preset of presets) {
    if (preset.updated) process.stderr.write(`[spark web] installed managed preset ${preset.id}\n`);
  }
  for (const retired of retiredPresets) {
    process.stderr.write(
      retired.removed
        ? `[spark web] retired generated legacy preset ${retired.id}\n`
        : `[spark web] kept ${retired.reason ?? "unknown"} legacy preset ${retired.id}\n`,
    );
  }
  const cueService = await ensureDshCueBundle(profileDir);
  if (cueService.rebuilt) {
    process.stderr.write(`[spark web] built dsh-cue service bundle -> ${cueService.bundle}\n`);
  }
  const cueTools = await ensureDshToolCueBundle(profileDir);
  if (cueTools.rebuilt) {
    process.stderr.write(`[spark web] built dsh-tool-cue plugin bundle -> ${cueTools.bundle}\n`);
  }
  const fusion = await ensureDshToolFusionBundle(profileDir);
  if (fusion.rebuilt) {
    process.stderr.write(`[spark web] built dsh-tool-fusion plugin bundle -> ${fusion.bundle}\n`);
  }
  const webProvider = await ensureDshWebProviderBundle(profileDir);
  if (webProvider.rebuilt) {
    process.stderr.write(
      `[spark web] built dsh-web-provider plugin bundle -> ${webProvider.bundle}\n`,
    );
  }
  const webTools = await ensureDshToolWebBundle(profileDir);
  if (webTools.rebuilt) {
    process.stderr.write(`[spark web] built dsh-tool-web plugin bundle -> ${webTools.bundle}\n`);
  }
  const bundle = await ensureSparkLlmBundle(profileDir);
  if (bundle.rebuilt) {
    process.stderr.write(`[spark web] built spark-llm plugin bundle -> ${bundle.bundle}\n`);
  }
  const subagent = await ensureSparkSessionSubagentBundle(profileDir);
  if (subagent.rebuilt) {
    process.stderr.write(
      `[spark web] built spark-session-subagent plugin bundle -> ${subagent.bundle}\n`,
    );
  }
  const client = await ensureSparkWebClient(profileDir);
  if (client.rebuilt) {
    process.stderr.write(
      `[spark web] built spark-web-dsh host/client bundles under ${join(client.packageDir, "lib")}\n`,
    );
  }
  if (client.linked) {
    process.stderr.write(`[spark web] linked ${SPARK_WEB_DHS_PACKAGE} into the DSH profile\n`);
  }

  const port = args.port ?? (await nextFreeWebPort(3080));
  if (port !== 3080 && args.port === undefined) {
    process.stderr.write(`[spark web] port 3080 is in use — serving on ${port}\n`);
  }
  const targetPort = await nextFreeWebPort(randomInt(49_152, 65_437), 99, [port]);
  const proxyCredential = randomBytes(32).toString("base64url");
  const childArgs: SparkWebArgs = { ...args, host: undefined };
  const patch = composeSparkWebPatch(profileDir);
  return {
    profileDir,
    patches: [patch.path],
    webArgs: composeWebArgs(childArgs, targetPort),
    proxy: { host: args.host ?? "127.0.0.1", port, targetPort, credential: proxyCredential },
  };
}

/** Boot the DSH web profile through the dispatcher launcher. */
export async function runSparkWeb(args: SparkWebArgs): Promise<number> {
  const prepared = await prepareSparkWebDispatch(args);
  const proxy = await startSparkWebDshAuthProxy({
    host: prepared.proxy.host,
    port: prepared.proxy.port,
    targetPort: prepared.proxy.targetPort,
    proxyCredential: prepared.proxy.credential,
  });
  const displayHost = prepared.proxy.host.includes(":")
    ? `[${prepared.proxy.host}]`
    : prepared.proxy.host;
  process.stdout.write(`spark web-dsh: http://${displayHost}:${prepared.proxy.port}/\n`);
  try {
    return await runSparkWebDirect(
      prepared.profileDir,
      prepared.patches,
      prepared.webArgs,
      prepared.proxy.credential,
    );
  } finally {
    await proxy.close();
  }
}
