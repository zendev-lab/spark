/**
 * Build the spark-web DSH client bundle for the DSH web runtime.
 *
 * Output: `lib/client.js` — a `window.__ModuleLoader__.load({...})` module
 * (the DSH client plugin wire format). `react`, `react/jsx-runtime`, and
 * `@deepseek-ai/*` stay external; the browser-side ModuleLoader resolves them
 * from the shared DSH web module graph at load time.
 */
import { build } from "esbuild";

const PACKAGE_ID = "@zendev-lab/spark-web-dsh";

await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  jsx: "automatic",
  outfile: "lib/client.js",
  external: ["react", "react/jsx-runtime", "@deepseek-ai/*"],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: "} });" },
  logLevel: "info",
});

// The host half is a build artifact too (the DSH loader imports the package
// main entry, which must exist in lib/).
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("lib", { recursive: true });
writeFileSync("lib/index.js", "function apply() {}\nexport { apply };\n");
