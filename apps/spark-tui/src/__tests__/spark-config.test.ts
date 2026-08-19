import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
  DEFAULT_SPARK_CONFIG,
  loadSparkConfig,
  mergeWithDefault as mergeSparkConfigWithDefault,
  saveSparkConfig,
} from "../host/config.ts";
import { DEFAULT_SPARK_EXTENSION_SPECS } from "../host/extension-specs.ts";

test("default Spark providers include shared Baidu OneAPI and OpenAI Codex adapters", () => {
  assert.deepEqual(DEFAULT_SPARK_CONFIG.providers, [
    "@zendev-lab/spark-llm/baidu-oneapi-provider",
    "@zendev-lab/spark-llm/openai-codex-provider",
  ]);
  assert.equal(
    DEFAULT_SPARK_CONFIG.extensions.includes("@zendev-lab/spark-graft/extension"),
    false,
  );
  assert.deepEqual(DEFAULT_SPARK_CONFIG.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS]);
  assert.equal(CURRENT_SPARK_EXTENSION_PROFILE_VERSION, 3);
  assert.equal(
    DEFAULT_SPARK_CONFIG.extensionProfileVersion,
    CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
  );
  assert.equal(DEFAULT_SPARK_CONFIG.activeThinkingLevel, "high");
  assert.deepEqual(DEFAULT_SPARK_CONFIG.enabledModels, [
    "openai-codex/gpt-5.6-*",
    "baidu-oneapi/claude-opus-5",
    "baidu-oneapi/deepseek-v4-flash",
    "baidu-oneapi/gpt-5.6-*",
    "baidu-oneapi/grok-4.6",
  ]);
});

test("bundled legacy model defaults migrate without re-enabling compatibility models", () => {
  assert.deepEqual(
    mergeSparkConfigWithDefault({
      enabledModels: [
        "openai-codex/gpt-5.6-luna",
        "openai-codex/gpt-5.6-sol",
        "openai-codex/gpt-5.6-terra",
        "baidu-oneapi/gpt-5.6-luna",
        "baidu-oneapi/gpt-5.6-sol",
        "baidu-oneapi/gpt-5.6-terra",
      ],
    }).enabledModels,
    DEFAULT_SPARK_CONFIG.enabledModels,
  );
  assert.deepEqual(
    mergeSparkConfigWithDefault({
      enabledModels: [
        "openai-codex/gpt-5.6-*",
        "baidu-oneapi/claude-opus-5",
        "baidu-oneapi/deepseek-v4-flash",
        "baidu-oneapi/gpt-5.6-*",
        "baidu-oneapi/grok-4.5",
      ],
    }).enabledModels,
    DEFAULT_SPARK_CONFIG.enabledModels,
  );
  assert.deepEqual(
    mergeSparkConfigWithDefault({ enabledModels: ["openai-codex/*"] }).enabledModels,
    ["openai-codex/*"],
  );
  assert.deepEqual(
    mergeSparkConfigWithDefault({ enabledModels: ["baidu-oneapi/*"] }).enabledModels,
    ["baidu-oneapi/*"],
  );
  assert.deepEqual(mergeSparkConfigWithDefault({ enabledModels: [] }).enabledModels, []);
});

test("catalog/reconnect saves keep explicit grok-4.6 and only normalize in memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-enabled-models-"));
  try {
    const path = join(dir, "config.json");
    const explicit = [
      "openai-codex/gpt-5.6-*",
      "baidu-oneapi/claude-opus-5",
      "baidu-oneapi/deepseek-v4-flash",
      "baidu-oneapi/gpt-5.6-*",
      "baidu-oneapi/grok-4.6",
    ];
    await writeFile(path, `${JSON.stringify({ enabledModels: explicit })}\n`, "utf8");

    const loaded = await loadSparkConfig(path);
    assert.deepEqual(loaded.enabledModels, DEFAULT_SPARK_CONFIG.enabledModels);
    assert.equal(loaded.enabledModels?.includes("baidu-oneapi/grok-4.6"), true);
    assert.equal(loaded.enabledModels?.includes("baidu-oneapi/grok-4.5"), false);

    await saveSparkConfig(
      {
        ...loaded,
        enabledModels: [
          "openai-codex/gpt-5.6-*",
          "baidu-oneapi/claude-opus-5",
          "baidu-oneapi/deepseek-v4-flash",
          "baidu-oneapi/gpt-5.6-*",
          "baidu-oneapi/grok-4.5",
        ],
        activeModelId: "baidu-oneapi/grok-4.5",
      },
      path,
    );

    const onDisk = JSON.parse(await readFile(path, "utf8")) as { enabledModels: string[] };
    assert.deepEqual(onDisk.enabledModels, explicit);
    assert.equal(onDisk.enabledModels.includes("baidu-oneapi/grok-4.6"), true);
    assert.equal(onDisk.enabledModels.includes("baidu-oneapi/grok-4.5"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Compact V2 config defaults to 40% reduction and current session model", () => {
  const compact = DEFAULT_SPARK_CONFIG.compact;
  assert.ok(compact);
  assert.equal(compact.targetReduction, 0.4);
  assert.equal(compact.compactModel, "current");

  const merged = mergeSparkConfigWithDefault({
    compact: {
      targetReduction: 0.25,
      compactModel: " openai/gpt-5-mini ",
      microThreshold: 3,
      fullThreshold: 0.2,
    },
  });
  assert.equal(merged.compact?.targetReduction, 0.25);
  assert.equal(merged.compact?.compactModel, "openai/gpt-5-mini");
  assert.equal(merged.compact?.microThreshold, DEFAULT_SPARK_CONFIG.compact?.microThreshold);
  assert.equal(merged.compact?.fullThreshold, DEFAULT_SPARK_CONFIG.compact?.fullThreshold);

  const oneSided = mergeSparkConfigWithDefault({ compact: { microThreshold: 0.8 } });
  assert.equal(oneSided.compact?.microThreshold, 0.8);
  assert.equal(oneSided.compact?.fullThreshold, DEFAULT_SPARK_CONFIG.compact?.fullThreshold);
});

test("legacy bundled extension profiles migrate to current defaults without Graft", () => {
  const historical = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-llm/models-extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-graft/extension",
    "@zendev-lab/pi-extension/extension",
    "my-extension",
  ];

  const migrated = mergeSparkConfigWithDefault({ extensions: historical });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
  assert.equal(migrated.extensions.includes("@zendev-lab/spark-graft/extension"), false);
  assert.equal(migrated.extensionProfileVersion, CURRENT_SPARK_EXTENSION_PROFILE_VERSION);
});

test("version-one default extension profiles gain the mandatory evidence capability", () => {
  const versionOneDefaults = DEFAULT_SPARK_EXTENSION_SPECS.filter(
    (specifier) => specifier !== "@zendev-lab/spark-artifacts/extension",
  );
  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: 1,
    extensions: [...versionOneDefaults, "my-extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
  assert.equal(migrated.extensionProfileVersion, CURRENT_SPARK_EXTENSION_PROFILE_VERSION);
});

test("version-one custom extension subsets remain explicit", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: 1,
    extensions: ["@zendev-lab/spark-cue/extension", "my-extension"],
  });

  assert.deepEqual(migrated.extensions, ["@zendev-lab/spark-cue/extension", "my-extension"]);
});

test("legacy singleton facade recovers the canonical default extension profile", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/pi-extension/extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS]);
});

test("legacy facade plus custom extensions restores defaults and preserves custom entries", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/pi-extension/extension", "my-extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
});

test("current Spark-native facade alone with profile version recovers defaults", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-extension/extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS]);
});

test("persisted v1 default profile gains the current artifact and workflow capabilities", () => {
  const v1Defaults = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-files/extension",
    "@zendev-lab/spark-llm/models-extension",
    "@zendev-lab/spark-memory/extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-session/extension",
    "@zendev-lab/spark-web/extension",
    "@zendev-lab/spark-extension/extension",
  ];

  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: 1,
    extensions: [...v1Defaults, "my-extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
  assert.equal(migrated.extensionProfileVersion, CURRENT_SPARK_EXTENSION_PROFILE_VERSION);
  assert.equal(migrated.extensions.includes("@zendev-lab/spark-artifacts/extension"), true);
  assert.equal(migrated.extensions.includes("@zendev-lab/spark-workflows/extension"), false);
});

test("persisted v1 custom subsets remain explicit across profile migration", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: 1,
    extensions: ["@zendev-lab/spark-extension/extension", "my-extension"],
  });

  assert.deepEqual(migrated.extensions, ["@zendev-lab/spark-extension/extension", "my-extension"]);
  assert.equal(migrated.extensionProfileVersion, CURRENT_SPARK_EXTENSION_PROFILE_VERSION);
});

test("persisted v2 default profile drops standalone workflow after composition owns it", () => {
  const v2Defaults = [
    "@zendev-lab/spark-ask/extension",
    "@zendev-lab/spark-artifacts/extension",
    "@zendev-lab/spark-cue/extension",
    "@zendev-lab/spark-llm/models-extension",
    "@zendev-lab/spark-memory/extension",
    "@zendev-lab/spark-roles/extension",
    "@zendev-lab/spark-session/extension",
    "@zendev-lab/spark-web/extension",
    "@zendev-lab/spark-workflows/extension",
    "@zendev-lab/spark-extension/extension",
  ];

  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: 2,
    extensions: [...v2Defaults, "my-extension"],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
  assert.equal(migrated.extensions.includes("@zendev-lab/spark-workflows/extension"), false);
  assert.equal(migrated.extensionProfileVersion, CURRENT_SPARK_EXTENSION_PROFILE_VERSION);
});

test("current profiles rewrite the retired spark-web search-tool specifier", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
    extensions: [
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-extension/extension",
      "my-extension",
    ],
  });

  assert.deepEqual(migrated.extensions, [
    "@zendev-lab/spark-tool-web/extension",
    "@zendev-lab/spark-extension/extension",
    "my-extension",
  ]);
});

test("current profiles remove a conflicting standalone workflow entry", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
    extensions: [
      "@zendev-lab/spark-workflows/extension",
      "@zendev-lab/spark-extension/extension",
      "my-extension",
    ],
  });

  assert.deepEqual(migrated.extensions, ["@zendev-lab/spark-extension/extension", "my-extension"]);
});

test("unversioned Spark-native default profile also gains current capabilities", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: [
      "@zendev-lab/spark-ask/extension",
      "@zendev-lab/spark-cue/extension",
      "@zendev-lab/spark-files/extension",
      "@zendev-lab/spark-llm/models-extension",
      "@zendev-lab/spark-memory/extension",
      "@zendev-lab/spark-roles/extension",
      "@zendev-lab/spark-session/extension",
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-extension/extension",
    ],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS]);
});

test("unversioned legacy default profile drops formerly bundled Graft", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: [
      "@zendev-lab/spark-ask/extension",
      "@zendev-lab/spark-cue/extension",
      "@zendev-lab/spark-files/extension",
      "@zendev-lab/spark-llm/models-extension",
      "@zendev-lab/spark-memory/extension",
      "@zendev-lab/spark-roles/extension",
      "@zendev-lab/spark-session/extension",
      "@zendev-lab/spark-web/extension",
      "@zendev-lab/spark-graft/extension",
      "@zendev-lab/spark-extension/extension",
      "my-extension",
    ],
  });

  assert.deepEqual(migrated.extensions, [...DEFAULT_SPARK_EXTENSION_SPECS, "my-extension"]);
  assert.equal(migrated.extensions.includes("@zendev-lab/spark-graft/extension"), false);
});

test("versioned pi-extension entries rewrite to spark-extension without profile rebuild", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
    extensions: ["@zendev-lab/pi-extension/extension", "@zendev-lab/spark-cue", "my-extension"],
  });

  assert.deepEqual(migrated.extensions, [
    "@zendev-lab/spark-extension/extension",
    "@zendev-lab/spark-cue",
    "my-extension",
  ]);
});

test("standalone Graft remains an explicit opt-in across profile migration", () => {
  const migrated = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-graft/extension"],
  });

  assert.deepEqual(migrated.extensions, ["@zendev-lab/spark-graft/extension"]);
});

test("loadSparkConfig returns default config when file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-missing-"));
  try {
    const path = join(dir, "config.json");
    const config = await loadSparkConfig(path);
    assert.deepEqual(config.extensions, DEFAULT_SPARK_CONFIG.extensions);
    assert.deepEqual(config.providers, DEFAULT_SPARK_CONFIG.providers);
    assert.equal(config.activeModelId, undefined);
    assert.equal(config.activeProvider, undefined);
    assert.equal(config.activeThinkingLevel, "high");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSparkConfig ignores malformed JSON and returns defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-malformed-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, "{ not-json", "utf8");
    const config = await loadSparkConfig(path);
    assert.deepEqual(config.providers, DEFAULT_SPARK_CONFIG.providers);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSparkConfig + saveSparkConfig round-trip preserves user fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-config-roundtrip-"));
  try {
    const path = join(dir, "config.json");
    await saveSparkConfig(
      {
        extensionProfileVersion: CURRENT_SPARK_EXTENSION_PROFILE_VERSION,
        extensions: ["@zendev-lab/pi-extension/extension", "@zendev-lab/spark-cue", "my-extension"],
        providers: ["@zendev-lab/spark-llm/baidu-oneapi-provider", "my-provider"],
        activeModelId: "baidu-oneapi/claude-opus-5",
        activeThinkingLevel: "medium",
        compact: {
          enabled: false,
          microThreshold: 0.7,
          fullThreshold: 0.95,
          targetReduction: 0.4,
          minUsefulReduction: 0.05,
          compactModel: " openai/gpt-5-mini ",
          reserveTokens: 12_000,
          keepRecentTokens: 8_000,
        },
      },
      path,
    );
    const config = await loadSparkConfig(path);
    assert.deepEqual(config.extensions, [
      "@zendev-lab/spark-extension/extension",
      "@zendev-lab/spark-cue",
      "my-extension",
    ]);
    assert.deepEqual(config.providers, [
      "@zendev-lab/spark-llm/baidu-oneapi-provider",
      "@zendev-lab/spark-llm/openai-codex-provider",
      "my-provider",
    ]);
    assert.equal(config.activeModelId, "baidu-oneapi/claude-opus-5");
    assert.equal(config.activeProvider, undefined);
    assert.equal(config.activeModel, undefined);
    assert.equal(config.activeThinkingLevel, "medium");
    assert.deepEqual(config.compact, {
      enabled: false,
      microThreshold: 0.7,
      fullThreshold: 0.95,
      targetReduction: 0.4,
      minUsefulReduction: 0.05,
      compactModel: "openai/gpt-5-mini",
      reserveTokens: 12_000,
      keepRecentTokens: 8_000,
    });
    assert.equal("fusion" in config, false);

    // Saved file is JSON with trailing newline
    const onDisk = await readFile(path, "utf8");
    assert.match(onDisk, /\}\n$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mergeSparkConfigWithDefault restores bundled providers to legacy provider lists", () => {
  const merged = mergeSparkConfigWithDefault({
    providers: ["@zendev-lab/spark-llm/baidu-oneapi-provider", "my-provider"],
  });

  assert.deepEqual(merged.providers, [
    "@zendev-lab/spark-llm/baidu-oneapi-provider",
    "@zendev-lab/spark-llm/openai-codex-provider",
    "my-provider",
  ]);
});

test("mergeSparkConfigWithDefault migrates legacy activeProvider/activeModel to activeModelId", () => {
  const merged = mergeSparkConfigWithDefault({
    activeProvider: "baidu-oneapi",
    activeModel: "claude-opus-4.8",
  });

  assert.equal(merged.activeModelId, "baidu-oneapi/claude-opus-4.8");
  assert.equal(merged.activeProvider, "baidu-oneapi");
  assert.equal(merged.activeModel, "claude-opus-4.8");
});

test("mergeSparkConfigWithDefault tolerates missing keys, partial inputs, and bogus arrays", () => {
  const merged = mergeSparkConfigWithDefault({
    extensions: ["@zendev-lab/spark-cue", 42, ""],
    providers: undefined,
    activeProvider: 7,
    activeModel: "claude-opus-4.6",
    activeThinkingLevel: "fast",
    fusion: {
      analysisModels: [{ provider: "fake", model: "a" }, { provider: "bad" }, null],
      judgeModel: { provider: "fake", model: "judge" },
      panelSize: 99,
    },
  });
  // 42 and "" are filtered out because the schema only accepts non-empty strings
  assert.deepEqual(merged.extensions, ["@zendev-lab/spark-cue"]);
  assert.deepEqual(merged.providers, DEFAULT_SPARK_CONFIG.providers);
  assert.equal(merged.activeModelId, "claude-opus-4.6");
  assert.equal(merged.activeProvider, undefined);
  assert.equal(merged.activeModel, "claude-opus-4.6");
  assert.equal(merged.activeThinkingLevel, "high");
  assert.equal("fusion" in merged, false);
});
