import { readdir, readFile, rm, writeFile } from "node:fs/promises";

for (const path of ["src/paraglide/.gitignore", "src/paraglide/.prettierignore"]) {
  await rm(new URL(`../${path}`, import.meta.url), { force: true });
}

await sanitizeGeneratedReadme();
await repairGeneratedRuntimeWarnings();
await repairGeneratedUnsafeTypes();
await normalizeGeneratedText(new URL("../src/paraglide/", import.meta.url));

async function sanitizeGeneratedReadme() {
  const readmeUrl = new URL("../src/paraglide/README.md", import.meta.url);
  const source = await readFile(readmeUrl, "utf8");
  const sanitized = source.replace(
    /^Compiled from: .*$/mu,
    "Compiled from: `packages/spark-i18n/project.inlang`",
  );
  if (sanitized !== source) await writeFile(readmeUrl, sanitized);
}

async function repairGeneratedRuntimeWarnings() {
  const runtimeUrl = new URL("../src/paraglide/runtime.js", import.meta.url);
  let source = await readFile(runtimeUrl, "utf8");
  const replacements = [
    ["setLocale(resolved, { reload: false });", "void setLocale(resolved, { reload: false });"],
    [
      '`Invalid locale: ${input}. Expected one of: ${locales.join(", ")}`',
      '`Invalid locale: ${String(input)}. Expected one of: ${locales.join(", ")}`',
    ],
    [
      "Promise.resolve().then(clearLocaleCookieCache);",
      "void Promise.resolve().then(clearLocaleCookieCache);",
    ],
  ];
  for (const [generated, repaired] of replacements) {
    const occurrences = source.split(generated).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `expected exactly one generated Paraglide runtime occurrence of ${JSON.stringify(generated)}, found ${occurrences}`,
      );
    }
    source = source.replace(generated, repaired);
  }
  await writeFile(runtimeUrl, source);
}

async function repairGeneratedUnsafeTypes() {
  const runtimeUrl = new URL("../src/paraglide/runtime.js", import.meta.url);
  const runtimeTypesUrl = new URL("../src/paraglide/runtime.d.ts", import.meta.url);
  const serverUrl = new URL("../src/paraglide/server.js", import.meta.url);

  let runtime = await readFile(runtimeUrl, "utf8");
  runtime = replaceExactlyOnce(
    runtime,
    "// ------ TYPES ------\nexport {};\n/**",
    "// ------ TYPES ------\n\n/**",
    "redundant empty module export",
  );
  runtime = replaceExactlyOnce(
    runtime,
    "/** @type {any} */\nconst URLPattern = {}",
    `/** @typedef {{ groups: Record<string, string | undefined> }} ParaglideUrlPatternComponentResult */
/**
 * @typedef {{
 *   hash: ParaglideUrlPatternComponentResult,
 *   hostname: ParaglideUrlPatternComponentResult,
 *   password: ParaglideUrlPatternComponentResult,
 *   pathname: ParaglideUrlPatternComponentResult,
 *   port: ParaglideUrlPatternComponentResult,
 *   protocol: ParaglideUrlPatternComponentResult,
 *   search: ParaglideUrlPatternComponentResult,
 *   username: ParaglideUrlPatternComponentResult,
 * }} ParaglideUrlPatternResult
 */
/**
 * @typedef {new (input: string, baseUrl?: string) => {
 *   exec(input: string): ParaglideUrlPatternResult | null
 * }} ParaglideUrlPatternConstructor
 */
const URLPattern = /** @type {ParaglideUrlPatternConstructor} */ (/** @type {unknown} */ ({}))`,
    "URLPattern constructor type",
  );
  runtime = replaceExactlyOnce(
    runtime,
    ` * \t\trun: (store: { locale?: Locale, origin?: string, messageCalls?: Set<string>},
 *    cb: any) => any`,
    ` * \t\trun: <Result>(store: { locale?: Locale, origin?: string, messageCalls?: Set<string>},
 *    cb: () => Result) => Result | Promise<Result>`,
    "AsyncLocalStorage callback type",
  );
  runtime = replaceExactlyOnce(
    runtime,
    `/** @type {any} */ (globalThis).__paraglide =
\t/** @type {any} */ (globalThis).__paraglide ?? {};
/** @type {any} */ (globalThis).__paraglide.ssr =
\t/** @type {any} */ (globalThis).__paraglide.ssr ?? {};`,
    `const paraglideGlobal = /** @type {typeof globalThis & {
 *   __paraglide?: { ssr?: Record<string, unknown> }
 * }} */ (globalThis);
paraglideGlobal.__paraglide ??= {};
paraglideGlobal.__paraglide.ssr ??= {};`,
    "global Paraglide state type",
  );
  runtime = replaceExactlyOnce(
    runtime,
    " * @param {any} match\n * @returns {URL}",
    " * @param {ParaglideUrlPatternResult} match\n * @returns {URL}",
    "fillMissingUrlParts match type",
  );
  runtime = replaceExactlyOnce(
    runtime,
    " * @param {any} match - The URLPattern match result object.",
    " * @param {ParaglideUrlPatternResult} match - The URLPattern match result object.",
    "aggregateGroups match type",
  );
  await writeFile(runtimeUrl, runtime);

  let runtimeTypes = await readFile(runtimeTypesUrl, "utf8");
  runtimeTypes = replaceExactlyOnce(
    runtimeTypes,
    " * @param {any} match - The URLPattern match result object.",
    " * @param {ParaglideUrlPatternResult} match - The URLPattern match result object.",
    "runtime declaration aggregateGroups comment",
  );
  runtimeTypes = replaceExactlyOnce(
    runtimeTypes,
    "export function aggregateGroups(match: any): Record<string, string | null | undefined>;",
    `export type ParaglideUrlPatternComponentResult = {
    groups: Record<string, string | undefined>;
};
export type ParaglideUrlPatternResult = {
    hash: ParaglideUrlPatternComponentResult;
    hostname: ParaglideUrlPatternComponentResult;
    password: ParaglideUrlPatternComponentResult;
    pathname: ParaglideUrlPatternComponentResult;
    port: ParaglideUrlPatternComponentResult;
    protocol: ParaglideUrlPatternComponentResult;
    search: ParaglideUrlPatternComponentResult;
    username: ParaglideUrlPatternComponentResult;
};
export function aggregateGroups(match: ParaglideUrlPatternResult): Record<string, string | null | undefined>;`,
    "runtime declaration aggregateGroups type",
  );
  runtimeTypes = replaceExactlyOnce(
    runtimeTypes,
    ` * \t\trun: (store: { locale?: Locale, origin?: string, messageCalls?: Set<string>},
 *    cb: any) => any`,
    ` * \t\trun: <Result>(store: { locale?: Locale, origin?: string, messageCalls?: Set<string>},
 *    cb: () => Result) => Result`,
    "runtime declaration AsyncLocalStorage comment",
  );
  runtimeTypes = replaceExactlyOnce(
    runtimeTypes,
    `export type ParaglideAsyncLocalStorage = {
    getStore(): {
        locale?: Locale;
        origin?: string;
        messageCalls?: Set<string>;
    } | undefined;
    run: (store: {
        locale?: Locale;
        origin?: string;
        messageCalls?: Set<string>;
    }, cb: any) => any;
};`,
    `export type ParaglideAsyncLocalStorage = {
    getStore(): {
        locale?: Locale;
        origin?: string;
        messageCalls?: Set<string>;
    } | undefined;
    run<Result>(store: {
        locale?: Locale;
        origin?: string;
        messageCalls?: Set<string>;
    }, cb: () => Result): Result | Promise<Result>;
};`,
    "runtime declaration AsyncLocalStorage signature",
  );
  await writeFile(runtimeTypesUrl, runtimeTypes);

  let server = await readFile(serverUrl, "utf8");
  server = replaceExactlyOnce(
    server,
    " * @template T - The return type of the resolve function\n *\n",
    "",
    "middleware unconstrained result template",
  );
  server = replaceExactlyOnce(
    server,
    ' * @param {(args: { request: Request, locale: import("./runtime.js").Locale }) => T | Promise<T>} resolve - Function to handle the request. The callback receives:',
    ' * @param {(args: { request: Request, locale: import("./runtime.js").Locale }) => Response | Promise<Response>} resolve - Function to handle the request. The callback receives:',
    "middleware resolve type",
  );
  server = replaceExactlyOnce(
    server,
    "    /** @type {any} */\n    let currentStore = undefined;",
    `    /** @type {ReturnType<import("./runtime.js").ParaglideAsyncLocalStorage["getStore"]>} */
    let currentStore = undefined;`,
    "mock AsyncLocalStorage store type",
  );
  await writeFile(serverUrl, server);

  const serverTypesUrl = new URL("../src/paraglide/server.d.ts", import.meta.url);
  let serverTypes = await readFile(serverTypesUrl, "utf8");
  serverTypes = replaceExactlyOnce(
    serverTypes,
    " * @template T - The return type of the resolve function\n *\n",
    "",
    "middleware declaration unconstrained result template",
  );
  serverTypes = replaceExactlyOnce(
    serverTypes,
    "export function paraglideMiddleware<T>(request: Request, resolve:",
    "export function paraglideMiddleware(request: Request, resolve:",
    "middleware declaration generic",
  );
  serverTypes = replaceExactlyOnce(
    serverTypes,
    ") => T | Promise<T>, options?: {",
    ") => Response | Promise<Response>, options?: {",
    "middleware declaration resolve type",
  );
  await writeFile(serverTypesUrl, serverTypes);
}

function replaceExactlyOnce(source, generated, repaired, label) {
  const occurrences = source.split(generated).length - 1;
  if (occurrences !== 1) {
    throw new Error(`expected exactly one generated ${label}, found ${occurrences}`);
  }
  return source.replace(generated, repaired);
}

async function normalizeGeneratedText(rootUrl) {
  const entries = await readdir(rootUrl, { withFileTypes: true });
  for (const entry of entries) {
    const url = new URL(entry.name, rootUrl);
    if (entry.isDirectory()) {
      await normalizeGeneratedText(new URL(`${entry.name}/`, rootUrl));
      continue;
    }
    if (!entry.isFile() || !/\.(?:js|ts|json|md)$/u.test(entry.name)) {
      continue;
    }

    const source = await readFile(url, "utf8");
    const normalized = source.replace(/[ \t]+$/gmu, "").replace(/(?:\r?\n)*$/u, "\n");
    if (normalized !== source) {
      await writeFile(url, normalized);
    }
  }
}
