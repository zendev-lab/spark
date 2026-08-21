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
  footer: {
    js: `module.exports = { default: { name, inject, apply }, name, inject, apply }; return module.exports; } });`,
  },
  logLevel: "info",
});

// The DSH loader imports the package main entry as the host half. Build the
// cold-history safety fence instead of replacing it with a no-op stub.
await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "lib/index.js",
  external: ["@deepseek-ai/*"],
  logLevel: "info",
});

await build({
  entryPoints: ["../../packages/dsh-tool-cue/src/index.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "lib/dsh-tool-cue.mjs",
  external: ["@deepseek-ai/*"],
  minify: true,
  logLevel: "info",
});

await build({
  entryPoints: ["../../packages/spark-llm/src/dsh-plugin.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: "lib/spark-llm-dsh-plugin.mjs",
  external: ["@deepseek-ai/*", "@earendil-works/pi-ai", "@earendil-works/pi-ai/*"],
  minify: true,
  logLevel: "info",
});
