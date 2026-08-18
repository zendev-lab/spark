#!/usr/bin/env node
/**
 * One-command installer for the spark-llm DSH plugin.
 *
 * Builds nothing itself — chain it after `build:dsh-plugin` (see the package
 * script `install:dsh-plugin`). What it does, all idempotent:
 *
 * 1. Copies the built bundle `dist/dsh-plugin.mjs` into the DSH profile's
 *    `plugins/spark-llm/` directory and ensures the `index.mjs` mount file.
 * 2. Ensures the profile's `cordis.patch.yml` contains the `spark-llm` row
 *    (handles both the empty `[]` template and an existing patch list).
 * 3. Ensures `settings.yaml` has the top-level `spark-llm:` section with the
 *    provider display name. Never touches any other key.
 *
 * Existing user content is preserved: rows and sections are only appended
 * when absent, and comments around them stay untouched. A second run is a
 * no-op apart from refreshing the bundle copy.
 *
 * Usage:
 *   pnpm --filter @zendev-lab/spark-llm run install:dsh-plugin [--profile <name>]
 *
 * Profile resolution: `$DSH_HOME/profiles/<name>` with `$DSH_HOME` defaulting
 * to `~/.dsh` and the profile defaulting to `web`. After the install, restart
 * the DSH process and store `BAIDU_ONEAPI_API_KEY` through the Models page.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(SCRIPT_DIR, "..");
const BUNDLE = join(PACKAGE_DIR, "dist", "dsh-plugin.mjs");

const INDEX_MJS = `// Mount point for the spark-llm DSH plugin bundle.
// The bundle is built from the spark workspace:
//   pnpm --filter @zendev-lab/spark-llm run build:dsh-plugin
// and copied here as dsh-plugin.mjs by scripts/install-dsh-plugin.mjs.
export { default } from "./dsh-plugin.mjs";
`;

const PATCH_ROW = `- insert:
    # spark-llm Baidu OneAPI provider plugin, built from the spark workspace
    # (packages/spark-llm \`build:dsh-plugin\` -> dist/dsh-plugin.mjs, copied to
    # ./plugins/spark-llm/dsh-plugin.mjs). Registers the \`baidu-oneapi\` route
    # on the host LlmRuntime; credential BAIDU_ONEAPI_API_KEY is managed from
    # the web Models page. Requires a dsh restart to take effect.
    - id: spark-llm
      name: ./plugins/spark-llm/index.mjs
`;

const SETTINGS_SECTION = `# Baidu OneAPI gateway via the spark-llm DSH plugin
# (cordis.patch.yml row \`spark-llm\` -> ./plugins/spark-llm/index.mjs).
# Store BAIDU_ONEAPI_API_KEY through the web Models page (credentials file);
# this section only holds display metadata.
spark-llm:
  providers:
    baidu-oneapi:
      displayName: Baidu OneAPI
`;

function fail(message) {
  console.error(`[install:dsh-plugin] ${message}`);
  process.exit(1);
}

function ensureProfileDir(dshHome, profileName) {
  const dir = join(dshHome, "profiles", profileName);
  if (!existsSync(join(dir, "cordis.patch.yml"))) {
    const profilesRoot = join(dshHome, "profiles");
    const found = existsSync(profilesRoot)
      ? readdirSync(profilesRoot).filter((entry) =>
          existsSync(join(profilesRoot, entry, "cordis.patch.yml")),
        )
      : [];
    fail(
      `profile "${profileName}" not found at ${dir} (no cordis.patch.yml). ` +
        (found.length > 0
          ? `Existing profiles: ${found.join(", ")}. Pass --profile <name>.`
          : "No profiles found under " + profilesRoot + "."),
    );
  }
  return dir;
}

function ensureBundle(profileDir) {
  if (!existsSync(BUNDLE)) {
    fail(
      `bundle not found at ${BUNDLE} — run "pnpm --filter @zendev-lab/spark-llm run build:dsh-plugin" first.`,
    );
  }
  const pluginDir = join(profileDir, "plugins", "spark-llm");
  mkdirSync(pluginDir, { recursive: true });
  copyFileSync(BUNDLE, join(pluginDir, "dsh-plugin.mjs"));
  const index = join(pluginDir, "index.mjs");
  if (!existsSync(index)) writeFileSync(index, INDEX_MJS);
  return pluginDir;
}

function ensurePatchRow(profileDir) {
  const patchPath = join(profileDir, "cordis.patch.yml");
  const original = readFileSync(patchPath, "utf8");
  if (original.includes("id: spark-llm")) return "row already present";
  let next;
  // The shipped template is an empty flow sequence (possibly with comment
  // lines above it); replace that `[]` line with the insert block so the
  // result stays one valid document. Any other content appends the block.
  const lines = original.split("\n");
  const lastMeaningful = [...lines].reverse().find((line) => line.trim().length > 0);
  if (lastMeaningful !== undefined && lastMeaningful.trim() === "[]") {
    const index = lines.lastIndexOf(lastMeaningful);
    next = [...lines.slice(0, index), PATCH_ROW].join("\n");
  } else {
    next = original.endsWith("\n") ? original + PATCH_ROW : original + "\n" + PATCH_ROW;
  }
  writeFileSync(patchPath, next);
  return "row appended";
}

function ensureSettingsSection(dshHome) {
  const settingsPath = join(dshHome, "settings.yaml");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, SETTINGS_SECTION);
    return "settings.yaml created";
  }
  const original = readFileSync(settingsPath, "utf8");
  if (/^spark-llm:/m.test(original)) return "section already present";
  const next = original.endsWith("\n")
    ? original + SETTINGS_SECTION
    : original + "\n" + SETTINGS_SECTION;
  writeFileSync(settingsPath, next);
  return "section appended";
}

function main() {
  const profileArg = process.argv.indexOf("--profile");
  const profileName = profileArg >= 0 ? process.argv[profileArg + 1] : "web";
  if (!profileName) fail("--profile requires a name.");

  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const profileDir = ensureProfileDir(dshHome, profileName);

  const pluginDir = ensureBundle(profileDir);
  console.log(`[install:dsh-plugin] bundle -> ${join(pluginDir, "dsh-plugin.mjs")}`);
  console.log(`[install:dsh-plugin] cordis.patch.yml: ${ensurePatchRow(profileDir)}`);
  console.log(`[install:dsh-plugin] settings.yaml: ${ensureSettingsSection(dshHome)}`);
  console.log(
    `[install:dsh-plugin] done. Next: restart dsh, store BAIDU_ONEAPI_API_KEY in the web Models page, and pick a Baidu OneAPI model in a new session.`,
  );
}

main();
