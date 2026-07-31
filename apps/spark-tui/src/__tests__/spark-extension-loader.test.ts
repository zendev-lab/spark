import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { SPARK_CHANNEL_ALLOWED_TOOLS } from "@zendev-lab/spark-host/system-prompt";
import {
  DEFAULT_SPARK_EXTENSION_SPECS,
  SparkExtensionLoader,
  SparkHostRuntime,
  SparkProviderRegistry,
  createSparkExtensionImporter,
  loadBuiltinExtensionFactories,
  loadPlugins,
  loadSparkExtensions,
} from "../host/index.ts";
import {
  createSparkNativeLocalControlSlashCommands,
  createSparkNativeRuntimeSlashCommands,
} from "../native-tui.ts";
import { catalogSparkNativeCommands } from "../native-tui/command-presentation.ts";
import { nativeKernelSlashCommandEntries } from "../native-tui/slash-commands.ts";

test("loadBuiltinExtensionFactories exposes the retained Spark CLI builtin extension set", () => {
  const builtinExpected = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-artifacts/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-fusion/extension",
    "@zendev-lab/spark-ai/models-extension",
    "@zendev-lab/spark-memory/extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-session/extension",
    "@zendev-lab/spark-web/extension",
    "@zendev-lab/spark-workflows/extension",
    "@zendev-lab/spark-graft/extension",
    "@zendev-lab/spark-extension/extension",
  ];
  const optInExtensions = new Set([
    "@zendev-lab/spark-fusion/extension",
    "@zendev-lab/spark-graft/extension",
  ]);
  const defaultExpected = builtinExpected.filter((specifier) => !optInExtensions.has(specifier));
  assert.deepEqual(
    loadBuiltinExtensionFactories().map((entry) => entry.specifier),
    builtinExpected,
  );
  assert.deepEqual([...DEFAULT_SPARK_EXTENSION_SPECS], defaultExpected);
});

test("default Spark extension profile leaves optional capabilities available only for opt-in", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-default-opt-in" });
  const result = await new SparkExtensionLoader({ api: host }).load();

  assert.equal(
    result.outcomes.some((outcome) => outcome.specifier === "@zendev-lab/spark-graft/extension"),
    false,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name.startsWith("graft_")),
    false,
  );
  assert.equal(
    result.outcomes.some((outcome) => outcome.specifier === "@zendev-lab/spark-fusion/extension"),
    false,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "fusion"),
    false,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "artifact"),
    true,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "evidence"),
    true,
  );
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "workflow"),
    true,
  );
});

test("default Spark extension profile exposes a bounded everyday TUI catalog", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-default-catalog" });
  await new SparkExtensionLoader({ api: host }).load();
  const commands = {
    ...createSparkNativeRuntimeSlashCommands(host),
    ...createSparkNativeLocalControlSlashCommands(),
  };
  const visible = catalogSparkNativeCommands(commands, nativeKernelSlashCommandEntries());
  const all = catalogSparkNativeCommands(commands, nativeKernelSlashCommandEntries(), {
    includeDeprecated: true,
  });

  const common = visible.filter((entry) => entry.group === "common").map((entry) => entry.name);
  assert.equal(common.length <= 7, true);
  assert.equal(
    common.every((name) =>
      ["help", "implement", "inbox", "plan", "retry", "status", "stop"].includes(name),
    ),
    true,
  );
  assert.equal(common.includes("help"), true);
  assert.equal(common.includes("plan"), true);
  assert.equal(common.includes("implement"), true);
  assert.equal(visible.find((entry) => entry.name === "automate")?.group, "automation");
  assert.equal(
    visible.some((entry) => entry.name === "inspect"),
    true,
  );
  assert.equal(
    visible.some((entry) => entry.name === "cockpit"),
    false,
  );
  assert.equal(
    visible.some((entry) => entry.name === "workflows" || entry.name === "workflow-pause"),
    false,
  );
  assert.equal(commands.workflows?.handler instanceof Function, true);
  assert.equal(commands["workflow-pause"]?.handler instanceof Function, true);
  assert.equal(
    all.find((entry) => entry.name === "workflows")?.deprecatedAliasFor,
    "/workflow list",
  );
  assert.equal(
    all.find((entry) => entry.name === "workflow-runs")?.deprecatedAliasFor,
    "/workflow runs [runRef]",
  );
  assert.equal(all.find((entry) => entry.name === "cockpit")?.deprecatedAliasFor, "/inspect");
});

test("root Pi extension list and native builtins both expose self-extension tools", async () => {
  const rootPackage = JSON.parse(
    await readFile(new URL("../../../../package.json", import.meta.url), "utf8"),
  ) as {
    pi?: { extensions?: string[] };
  };
  assert.ok(rootPackage.pi?.extensions?.includes("./packages/spark-memory/src/extension-entry.ts"));
  assert.ok(
    rootPackage.pi?.extensions?.includes("./packages/spark-session/src/extension-entry.ts"),
  );
  assert.ok(rootPackage.pi?.extensions?.includes("./packages/spark-web/src/extension-entry.ts"));
  assert.ok(
    rootPackage.pi?.extensions?.includes(
      "./packages/spark-ai/src/baidu-oneapi-compat-extension.ts",
    ),
  );
  assert.equal(
    rootPackage.pi?.extensions?.includes("./packages/spark-ai/src/baidu-oneapi-provider.ts"),
    false,
  );
  assert.equal(
    rootPackage.pi?.extensions?.includes("./packages/spark-graft/src/extension-entry.ts"),
    false,
  );
  assert.equal(
    rootPackage.pi?.extensions?.some((entry) => entry.includes("spark-fusion")),
    false,
  );
  assert.equal(
    rootPackage.pi?.extensions?.some((entry) => entry.includes("pi-extension")),
    false,
  );
  assert.ok(
    rootPackage.pi?.extensions?.includes("./packages/spark-extension/src/extension/index.ts"),
  );
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-memory/extension"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-session/extension"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-web/extension"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-artifacts/extension"));
  assert.ok([...DEFAULT_SPARK_EXTENSION_SPECS].includes("@zendev-lab/spark-workflows/extension"));
  assert.equal(
    (DEFAULT_SPARK_EXTENSION_SPECS as readonly string[]).includes(
      "@zendev-lab/spark-graft/extension",
    ),
    false,
  );
  assert.equal(
    (DEFAULT_SPARK_EXTENSION_SPECS as readonly string[]).includes(
      "@zendev-lab/spark-fusion/extension",
    ),
    false,
  );
});

test("Spark extension implementation and host-support are owned by spark-extension", async () => {
  const sparkExtensionPackage = JSON.parse(
    await readFile(
      new URL("../../../../packages/spark-extension/package.json", import.meta.url),
      "utf8",
    ),
  ) as { exports?: Record<string, string>; dependencies?: Record<string, string> };
  const hostPackage = JSON.parse(
    await readFile(
      new URL("../../../../packages/spark-host/package.json", import.meta.url),
      "utf8",
    ),
  ) as { dependencies?: Record<string, string>; exports?: Record<string, string> };
  const tuiPackage = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { dependencies?: Record<string, string> };

  assert.equal(sparkExtensionPackage.exports?.["./host-support"], "./src/host-support.ts");
  assert.equal(sparkExtensionPackage.exports?.["./extension"], "./src/extension/index.ts");
  assert.equal(sparkExtensionPackage.dependencies?.["@zendev-lab/pi-extension"], undefined);
  assert.equal(hostPackage.dependencies?.["@zendev-lab/pi-extension"], undefined);
  assert.equal(tuiPackage.dependencies?.["@zendev-lab/pi-extension"], undefined);
  assert.ok(tuiPackage.dependencies?.["@zendev-lab/spark-extension"]);
  assert.equal(hostPackage.exports?.["./spark-command-registration"], undefined);
  assert.equal(hostPackage.exports?.["./spark-command-workflow-registration"], undefined);
});

test("SparkExtensionLoader loads builtin factories through explicit imports", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-test", hasUI: true });
  const result = await new SparkExtensionLoader({
    api: host,
    extensions: [
      "@zendev-lab/spark-ask/extension",
      "@zendev-lab/spark-cue/extension",
      "@zendev-lab/spark-files/extension",
      "@zendev-lab/spark-fusion/extension",
      "@zendev-lab/spark-ai/models-extension",
      "@zendev-lab/spark-memory/extension",
      "@zendev-lab/spark-roles/extension",
      "@zendev-lab/spark-session/extension",
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-graft/extension",
      "@zendev-lab/spark-extension/extension",
    ],
  }).load();

  assert.equal(
    result.outcomes.every((outcome) => outcome.ok && outcome.builtin),
    true,
  );
  const tools = host.getActiveTools();
  assert.ok(tools.includes("ask"));
  assert.ok(!tools.includes("ask_user"));
  assert.ok(!tools.includes("ask_flow"));
  assert.ok(tools.includes("cue_exec"));
  assert.ok(tools.includes("read"));
  assert.ok(tools.includes("fusion"));
  assert.ok(tools.includes("models"));
  assert.ok(tools.includes("memory"));
  assert.ok(tools.includes("role"));
  assert.ok(tools.includes("session"));
  assert.ok(tools.includes("web_search"));
  assert.ok(tools.includes("fetch_content"));
  assert.ok(tools.includes("get_search_content"));
  assert.ok(!tools.includes("list_roles"));
  assert.ok(tools.includes("graft"));
  assert.ok(!tools.includes("graft_status"));
  assert.ok(!tools.includes("graft_patch"));
  assert.ok(!tools.includes("patch"));
  assert.ok(!tools.includes("task"));
  assert.ok(tools.includes("task_read"));
  assert.ok(tools.includes("task_write"));
  assert.ok(tools.includes("assign"));
  assert.equal(
    tools.some((tool) => tool.startsWith("spark_")),
    false,
  );
  const commands = host.listCommands().map((command) => command.name);
  assert.ok(!commands.includes("spark"));
  assert.ok(!commands.includes("research"));
  assert.ok(commands.includes("workflow:research"));
  assert.ok(!commands.some((command) => command.startsWith("graft-")));
});

test("workflow driver ticks activate the internal workflow tool through the host allowlist", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-extension-loader-workflow-driver",
    allowedTools: ["workflow_driver"],
  });
  const result = await new SparkExtensionLoader({
    api: host,
    extensions: ["@zendev-lab/spark-extension/extension"],
  }).load();

  assert.equal(
    result.outcomes.every((outcome) => outcome.ok),
    true,
  );
  assert.deepEqual(host.getActiveTools(), ["workflow_driver"]);
  assert.ok(host.getAllTools().some((tool) => tool.name === "workflow_driver"));
});

test("channel host keeps only explicitly allowed tools active after extension handlers", async () => {
  const host = new SparkHostRuntime({
    cwd: "/tmp/spark-extension-loader-channel",
    sessionSurface: "channel",
    allowedTools: SPARK_CHANNEL_ALLOWED_TOOLS,
  });
  const result = await new SparkExtensionLoader({ api: host }).load();
  assert.equal(
    result.outcomes.every((outcome) => outcome.ok),
    true,
  );

  await host.emit("session_start", { reason: "channel-turn" });
  assert.deepEqual(host.getActiveTools().sort(), ["ask", "context", "session", "todo"]);
});

test("SparkExtensionLoader isolates one extension failure and continues loading later extensions", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-extension-loader-failure" });
  const result = await loadSparkExtensions({
    api: host,
    extensions: ["bad-extension", "@zendev-lab/spark-ask/extension"],
    importer: async () => ({
      default: () => {
        throw new Error("boom");
      },
    }),
  });

  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0]!.ok, false);
  assert.match(result.outcomes[0]!.error ?? "", /boom/);
  assert.equal(result.outcomes[1]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask"),
    true,
  );
});

test("createSparkExtensionImporter resolves builtins without calling fallback importer", async () => {
  const importer = createSparkExtensionImporter(async () => {
    throw new Error("fallback should not be used for builtins");
  });
  const mod = await importer("@zendev-lab/spark-ask/extension");
  assert.equal(typeof (mod as { default?: unknown }).default, "function");
});

test("loadPlugins default importer is wired to builtin extension imports while providers stay dynamic", async () => {
  const host = new SparkHostRuntime({ cwd: "/tmp/spark-plugin-builtin-importer" });
  const registry = new SparkProviderRegistry();
  const result = await loadPlugins({
    extensionApi: host,
    providerApi: registry,
    extensions: ["@zendev-lab/spark-ask/extension"],
    providers: [],
  });

  assert.equal(result.outcomes[0]!.ok, true);
  assert.equal(
    host.getAllTools().some((tool) => tool.name === "ask"),
    true,
  );
});
