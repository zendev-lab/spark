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
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSupportedDshPackage,
  installManagedCuePresets,
} from "@zendev-lab/dsh-tool-cue/presets";

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

/** Locate the installed `@zendev-lab/dsh-tool-cue` package root. */
export function resolveDshToolCuePackageDir(): string {
  return resolvePackageDir("@zendev-lab/dsh-tool-cue");
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
  command = process.env.SPARK_WEB_COMMAND?.trim() || "dsh",
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

export interface DshToolCueBundleResult {
  entry: string;
  bundle: string;
  sourceDigest: string;
  rebuilt: boolean;
}

/** Bundle the host-neutral Cue operations and rc.7 adapter into the DSH profile. */
export async function ensureDshToolCueBundle(profileDir: string): Promise<DshToolCueBundleResult> {
  const packageDir = resolveDshToolCuePackageDir();
  const sparkCuePackage = resolveFromDirectory(packageDir, "@zendev-lab/spark-cue");
  if (sparkCuePackage === undefined) {
    throw new Error(`spark web: cannot locate @zendev-lab/spark-cue from ${packageDir}`);
  }
  const sparkCueDir = dirname(sparkCuePackage);
  const entry = join(packageDir, "src", "index.ts");
  const sourceDigest = hashSourceTree([
    entry,
    join(packageDir, "package.json"),
    join(sparkCueDir, "src"),
    sparkCuePackage,
  ]);
  const pluginDir = join(profileDir, "plugins", "dsh-tool-cue");
  const bundle = join(pluginDir, "index.mjs");
  const digestPath = join(pluginDir, ".source-sha256");
  const previousDigest = existsSync(digestPath) ? readFileSync(digestPath, "utf8").trim() : "";
  const rebuilt = !existsSync(bundle) || previousDigest !== sourceDigest;
  if (rebuilt) {
    mkdirSync(pluginDir, { recursive: true });
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
    writeFileSync(digestPath, `${sourceDigest}\n`);
  }
  return { entry, bundle, sourceDigest, rebuilt };
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
  return resolvePackageDir(SPARK_WEB_DHS_PACKAGE);
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
 * - `spark-llm` and `dsh-tool-cue` host plugins (relative to the profile root, so the DSH loader
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
  // The DSH loader imports the package main entry, so the host half must
  // exist next to the client bundle (mirror of the package build script).
  let linked = false;
  const before = resolveFromDirectory(profileDir, SPARK_WEB_DHS_PACKAGE);
  const beforeReal = before === undefined ? undefined : realpathSync(dirname(before));
  linkClientIntoProfile(profileDir, packageDir);
  if (beforeReal !== realpathSync(packageDir)) linked = true;
  // The loader imports the package main entry; if the host half is missing or
  // empty, the plugin load fails with "invalid plugin ... received undefined".
  const hostHalf = join(packageDir, "lib", "index.js");
  if (!existsSync(hostHalf) || !readFileSync(hostHalf, "utf8").includes("apply")) {
    writeFileSync(hostHalf, "function apply() {}\nexport { apply };\n");
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

/**
 * Link a workspace package into a DSH profile's node_modules with a plain
 * directory symlink (equivalent to `dsh plugin add link:<dir>`), so booting
 * never needs the external `dsh` CLI on the PATH.
 */
function linkClientIntoProfile(profileDir: string, packageDir: string): void {
  const target = join(profileDir, "node_modules", "@zendev-lab", SPARK_WEB_DHS_PACKAGE);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (!lstatSync(target).isSymbolicLink()) {
      throw new Error(`spark web: ${target} exists and is not a symlink`);
    }
    // The profile may still point at an older checkout (a worktree from a
    // previous session). Re-link whenever the source moved so the DSH loader
    // always imports the package this invocation builds from.
    if (realpathSync(target) === realpathSync(packageDir)) return;
    unlinkSync(target);
  }
  symlinkSync(packageDir, target, "junction");
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
    'import { readdirSync } from "node:fs";',
    'import { join } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'import { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";',
    "",
    `const patchFiles = [${patchFiles.map((file) => JSON.stringify(file)).join(", ")}];`,
    `const webArgs = [${webArgs.map((arg) => JSON.stringify(arg)).join(", ")}];`,
    "",
    "const dshPackageDir = process.argv[2];",
    'const libDir = join(dshPackageDir, "lib");',
    'const entry = readdirSync(libDir).find((file) => file.startsWith("profile-boot-") && file.endsWith(".js"));',
    "if (entry === undefined) {",
    "  throw new Error(`spark web: no profile-boot module found under ${libDir}`);",
    "}",
    "const { runProfile } = await import(pathToFileURL(join(libDir, entry)).href);",
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
    "    console.error(error instanceof Error ? error.message : String(error));",
    '    console.error("spark web: server failed to start; see the message above for details.");',
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

/** Spawn the DSH web profile through bare node running the boot script. */
export async function runSparkWebDirect(
  profileDir: string,
  patches: readonly string[],
  webArgs: readonly string[],
): Promise<number> {
  const dshPackageDir = resolveDshPackageDir(profileDir);
  const scriptPath = join(profileDir, "plugins", "spark-web-boot.mjs");
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, sparkWebBootScript(patches, webArgs));
  return await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [scriptPath, dshPackageDir], { stdio: "inherit" });
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
  if (!userPatch.includes("id: dsh-tool-cue")) {
    rows.push(
      "    # Cue-first command, script, job, and scope tools, managed by `spark web`.",
      "    - id: dsh-tool-cue",
      "      name: ./plugins/dsh-tool-cue/index.mjs",
    );
  }
  if (!userPatch.includes("id: spark-web-dsh")) {
    rows.push("    - id: spark-web-dsh", `      name: ${JSON.stringify(SPARK_WEB_DHS_PACKAGE)}`);
  }
  if (!userPatch.includes("id: agent-presets")) {
    rows.push("- id: agent-presets", "  config:", "    default: spark-standard");
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
export async function nextFreeWebPort(preferred = 3080, attempts = 100): Promise<number> {
  for (let port = preferred; port < preferred + attempts; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`spark web: no free port found from ${preferred} to ${preferred + attempts - 1}`);
}

export function composeWebArgs(args: SparkWebArgs, port = args.port ?? 3080): string[] {
  const webArgs = [`--port=${port}`];
  for (const trusted of args.trustedHosts) webArgs.push(`--trusted-host=${trusted}`);
  webArgs.push(...args.argv);
  return webArgs;
}

/**
 * Prepare a `spark web` dispatch: ensure the spark-llm bundle, compose the
 * patch overlay, and return the `dsh web` argument list.
 */
export interface SparkWebDispatch {
  /** The DSH profile the web server will be booted from. */
  profileDir: string;
  /** Patch overlay files for the spark-llm / spark-web-dsh rows. */
  patches: string[];
  /** Arguments passed to the web app after the patch overlays. */
  webArgs: string[];
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
  // Metadata and upstream source verification happen before any managed write.
  assertSupportedDshPackage(dshPackageDir);
  const presets = installManagedCuePresets(dshHome, dshPackageDir);
  for (const preset of presets) {
    if (preset.updated) process.stderr.write(`[spark web] installed managed preset ${preset.id}\n`);
  }
  const cue = await ensureDshToolCueBundle(profileDir);
  if (cue.rebuilt) {
    process.stderr.write(`[spark web] built dsh-tool-cue plugin bundle -> ${cue.bundle}\n`);
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
  const port = args.port ?? (await nextFreeWebPort(3080));
  if (port !== 3080 && args.port === undefined) {
    process.stderr.write(`[spark web] port 3080 is in use — serving on ${port}\n`);
  }
  return { profileDir, patches: [patch.path], webArgs: composeWebArgs(args, port) };
}

/** Boot the DSH web profile through the dispatcher launcher. */
export async function runSparkWeb(args: SparkWebArgs): Promise<number> {
  const prepared = await prepareSparkWebDispatch(args);
  return runSparkWebDirect(prepared.profileDir, prepared.patches, prepared.webArgs);
}
