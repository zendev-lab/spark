import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { createSparkPiParitySlashCommands } from "../cli/pi-parity-commands.ts";
import {
  BUILTIN_SPARK_THEMES,
  createSparkHostRenderTheme,
  loadSparkThemeCatalog,
  saveSparkConfig,
  type SparkCliHostServices,
  type SparkConfig,
  type SparkTheme,
  type SparkThemeColors,
} from "../host/index.ts";
import { createEditorTheme } from "../native-tui/theme-helpers.ts";
import { SparkNativeSession } from "../native-tui.ts";
import { createSparkNativeTuiComponentHarness } from "../test-support/spark-native-tui-component-harness.ts";

const ESC = String.fromCharCode(27);

const testTheme: SparkTheme = {
  id: "test",
  label: "Test Theme",
  mode: "dark",
  colors: {
    foreground: "#111111",
    muted: "#222222",
    border: "#333333",
    accent: "#010203",
    selected: "#020304",
    success: "#040506",
    warning: "#070809",
    error: "#0a0b0c",
    user: "#0d0e0f",
    assistant: "#101112",
    system: "#131415",
    tool: "#161718",
    thinking: "#191a1b",
    custom: "#1c1d1e",
    markdownHeading: "#1f2021",
    markdownCode: "#222324",
    markdownQuote: "#252627",
    diffAdd: "#010203",
    diffRemove: "#040506",
    diffHunk: "#070809",
  },
};

const THEME_COLOR_KEYS = [
  "foreground",
  "muted",
  "border",
  "accent",
  "selected",
  "success",
  "warning",
  "error",
  "user",
  "assistant",
  "system",
  "tool",
  "thinking",
  "custom",
  "markdownHeading",
  "markdownCode",
  "markdownQuote",
  "diffAdd",
  "diffRemove",
  "diffHunk",
] as const satisfies readonly (keyof SparkThemeColors)[];

const STATUS_COLOR_KEYS = ["success", "warning", "error"] as const;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spark-theme-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("builtin Spark themes define every color token with distinct semantic ANSI", () => {
  for (const theme of BUILTIN_SPARK_THEMES) {
    assert.deepEqual(Object.keys(theme.colors).sort(), [...THEME_COLOR_KEYS].sort());
    for (const key of THEME_COLOR_KEYS) assert.match(theme.colors[key], /^#[0-9a-f]{6}$/iu);

    const renderTheme = createSparkHostRenderTheme(theme);
    const foreground = renderTheme.fg("foreground", "token");
    const muted = renderTheme.fg("muted", "token");
    const semanticKeys = ["accent", "selected", ...STATUS_COLOR_KEYS] as const;
    const semanticOutput = semanticKeys.map((key) => renderTheme.fg(key, "token"));
    for (const output of semanticOutput) {
      assert.notEqual(output, foreground);
      assert.notEqual(output, muted);
    }
    assert.equal(new Set(semanticOutput).size, semanticOutput.length);
  }
});

test("native editor selection uses the selected theme token", () => {
  const editorTheme = createEditorTheme(testTheme).selectList;
  const selected = createSparkHostRenderTheme(testTheme).fg("selected", "choice");
  assert.equal(editorTheme.selectedPrefix("choice"), selected);
  assert.equal(editorTheme.selectedText("choice"), selected);
});

test("custom themes inherit selected and reject invalid ANSI color values", async () => {
  await withTempDir(async (dir) => {
    const sparkHome = join(dir, ".spark");
    const themesDir = join(sparkHome, "themes");
    await mkdir(themesDir, { recursive: true });
    await writeFile(
      join(themesDir, "legacy-light.json"),
      JSON.stringify({ id: "legacy-light", extends: "light", colors: { accent: "123456" } }),
      "utf8",
    );
    await writeFile(
      join(themesDir, "invalid.json"),
      JSON.stringify({
        id: "invalid",
        extends: "unknown-base",
        colors: {
          accent: "\u001b[31m",
          selected: "#abc",
          success: "",
          warning: "not-a-color",
          error: "#12zz34",
        },
      }),
      "utf8",
    );

    const catalog = await loadSparkThemeCatalog({ cwd: dir, sparkHome });
    const dark = BUILTIN_SPARK_THEMES.find((theme) => theme.id === "dark")!;
    const light = BUILTIN_SPARK_THEMES.find((theme) => theme.id === "light")!;
    const legacy = catalog.themes.find((theme) => theme.id === "legacy-light")!;
    const invalid = catalog.themes.find((theme) => theme.id === "invalid")!;

    assert.equal(legacy.mode, "light");
    assert.equal(legacy.colors.accent, "123456");
    assert.equal(legacy.colors.selected, light.colors.selected);
    assert.equal(invalid.mode, "dark");
    assert.equal(invalid.colors.accent, dark.colors.accent);
    assert.equal(invalid.colors.selected, dark.colors.selected);
    assert.equal(invalid.colors.success, dark.colors.success);
    assert.equal(invalid.colors.warning, dark.colors.warning);
    assert.equal(invalid.colors.error, dark.colors.error);

    const rendered = createSparkHostRenderTheme(invalid).fg("accent", "safe");
    assert.equal(rendered.includes(`${ESC}[31m`), false);
    assert.equal(rendered, createSparkHostRenderTheme(dark).fg("accent", "safe"));
  });
});

test("loadSparkThemeCatalog loads builtin and user themes with active fallback", async () => {
  await withTempDir(async (dir) => {
    const sparkHome = join(dir, ".spark");
    await mkdir(join(sparkHome, "themes"), { recursive: true });
    await writeFile(
      join(sparkHome, "themes", "solar.json"),
      JSON.stringify({
        id: "solar",
        label: "Solar Test",
        extends: "light",
        colors: { accent: "#123456", diffAdd: "#abcdef" },
      }),
      "utf8",
    );

    const catalog = await loadSparkThemeCatalog({ cwd: dir, sparkHome, activeThemeId: "solar" });
    assert.equal(catalog.active.id, "solar");
    assert.equal(catalog.active.colors.accent, "#123456");
    assert.equal(catalog.active.colors.diffAdd, "#abcdef");
    assert.equal(
      catalog.themes.some((theme) => theme.id === "dark"),
      true,
    );
    assert.equal(
      catalog.themes.some((theme) => theme.id === "light"),
      true,
    );
    assert.equal(
      catalog.themes.some((theme) => theme.id === "solar"),
      true,
    );

    const fallback = await loadSparkThemeCatalog({ cwd: dir, sparkHome, activeThemeId: "missing" });
    assert.equal(fallback.active.id, "dark");
    assert.match(fallback.diagnostics.map((item) => item.message).join("\n"), /Unknown active/);
  });
});

test("Spark native renderer applies theme colors to markdown and diff/tool output", () => {
  const harness = createSparkNativeTuiComponentHarness({ cols: 100, theme: testTheme });
  harness.session.appendAssistantChunk("# Heading\n\nHere is `code`.");
  harness.session.finishAssistantMessage();
  harness.session.addToolMessage({
    toolName: "edit",
    status: "success",
    text: "@@ file.ts @@\n+added line\n-removed line",
  });
  harness.app.toggleTools();

  const rendered = harness.render();
  assert.match(rendered, /Heading/);
  assert.match(rendered, /Here is .*code/);
  assert.match(rendered, /tool:edit \[succeeded\]/);
  assert.equal(rendered.includes(`${ESC}[38;2;1;2;3m+added line${ESC}[0m`), true);
  assert.equal(rendered.includes(`${ESC}[38;2;4;5;6m-removed line${ESC}[0m`), true);
  assert.equal(rendered.includes(`${ESC}[38;2;7;8;9m@@ file.ts @@${ESC}[0m`), true);
});

test("/settings set theme persists activeTheme through Spark config", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    const config: SparkConfig = {
      extensions: [],
      providers: [],
      activeTheme: "dark",
    };
    const services = {
      cwd: dir,
      config,
      saveConfig: (nextConfig: SparkConfig) => saveSparkConfig(nextConfig, path),
      theme: BUILTIN_SPARK_THEMES[0],
      themeCatalog: {
        themes: [...BUILTIN_SPARK_THEMES],
        active: BUILTIN_SPARK_THEMES[0]!,
        diagnostics: [],
      },
      modelSelector: { getActive: () => undefined },
      providerRegistry: { listProviders: () => [] },
      keybindings: { snapshot: () => ({ bindings: [] }) },
      diagnostics: [],
    } as unknown as SparkCliHostServices;
    const commands = createSparkPiParitySlashCommands(services);
    const result = await commands.settings!.handler("set theme light", {
      app: {} as never,
      session: new SparkNativeSession(async () => "unused"),
      exit: () => undefined,
    });

    assert.match(String(result), /Spark theme set: light/);
    const saved = JSON.parse(await readFile(path, "utf8")) as SparkConfig;
    assert.equal(saved.activeTheme, "light");
  });
});
