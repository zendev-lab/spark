import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { test } from "vitest";

import { parseSparkDispatcherArgs } from "./cli.ts";
import {
  composeSparkWebPatch,
  composeWebArgs,
  ensureDshToolCueBundle,
  ensureSparkLlmBundle,
  parseSparkWebArgs,
  prepareSparkWebDispatch,
  resolveDshProfileDir,
  resolveSparkLlmPackageDir,
  sparkWebBootScript,
} from "./web.ts";

test("parseSparkWebArgs reads host, port, trusted hosts, and forwards the rest", () => {
  assert.deepEqual(
    parseSparkWebArgs([
      "--host",
      "0.0.0.0",
      "--port",
      "8080",
      "--trusted-host",
      "lan.local",
      "leftover",
    ]),
    {
      host: "0.0.0.0",
      port: 8080,
      trustedHosts: ["lan.local"],
      argv: ["leftover"],
    },
  );
  assert.deepEqual(parseSparkWebArgs(["--host=192.168.1.5", "--trusted-host=a:3080"]), {
    host: "192.168.1.5",
    port: undefined,
    trustedHosts: ["a:3080"],
    argv: [],
  });
  assert.deepEqual(parseSparkWebArgs([]), {
    host: undefined,
    port: undefined,
    trustedHosts: [],
    argv: [],
  });
  assert.throws(() => parseSparkWebArgs(["--port", "abc"]), /must be a number/);
  assert.throws(() => parseSparkWebArgs(["--host"]), /requires a value/);
});

test("parseSparkDispatcherArgs routes spark web to the web target", () => {
  assert.deepEqual(parseSparkDispatcherArgs(["web", "--host", "0.0.0.0"]), {
    kind: "dispatch",
    target: "web",
    argv: ["--host", "0.0.0.0"],
  });
});

test("composeSparkWebPatch mounts spark-llm, enables HMR, and overrides webserver host for 0.0.0.0", () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-patch-"));
  try {
    const defaultPatch = composeSparkWebPatch(dir, { argv: [], trustedHosts: [] });
    const defaultText = defaultPatch.rows.join("\n");
    assert.match(defaultText, /- id: spark-llm/);
    assert.match(defaultText, /name: \.\/plugins\/spark-llm\/index\.mjs/);
    assert.match(defaultText, /- id: spark-web-dsh/);
    assert.match(defaultText, /- id: dsh-tool-cue/);
    assert.match(defaultText, /name: \.\/plugins\/dsh-tool-cue\/index\.mjs/);
    assert.match(defaultText, /- id: agent-presets\n  config:\n    default: spark-standard/);
    assert.match(defaultText, /name: ["']@zendev-lab\/spark-web-dsh["']/);
    assert.match(defaultText, /- id: hmr\n  disabled: false/);
    assert.doesNotMatch(defaultText, /- id: webserver/);
    assert.ok(existsSync(defaultPatch.path), "patch file written");

    const lanPatch = composeSparkWebPatch(dir, { host: "0.0.0.0", argv: [], trustedHosts: [] });
    assert.match(lanPatch.rows.join("\n"), /- id: webserver\n  config:\n    host: 0\.0\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSparkLlmBundle builds the plugin bundle into the profile and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-profile-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureSparkLlmBundle(profile);
    assert.ok(existsSync(first.bundle), "bundle written");
    assert.ok(existsSync(join(profile, "plugins", "spark-llm", "index.mjs")), "mount file written");
    assert.equal(first.rebuilt, true);

    const second = await ensureSparkLlmBundle(profile);
    assert.equal(second.rebuilt, false, "no rebuild when the bundle is newer than the source");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDshToolCueBundle uses a source digest and never writes the source checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-cue-bundle-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureDshToolCueBundle(profile);
    assert.equal(first.rebuilt, true);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(first.bundle));
    assert.ok(existsSync(join(profile, "plugins", "dsh-tool-cue", ".source-sha256")));

    const second = await ensureDshToolCueBundle(profile);
    assert.equal(second.rebuilt, false);
    assert.equal(second.sourceDigest, first.sourceDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spark-llm package resolves from the workspace and exposes the plugin entry", () => {
  const llmDir = resolveSparkLlmPackageDir();
  assert.ok(existsSync(join(llmDir, "src", "dsh-plugin.ts")), "plugin entry exists");
});

test("resolveDshProfileDir honors DSH_HOME", () => {
  assert.equal(resolveDshProfileDir("/tmp/dsh-home"), "/tmp/dsh-home/profiles/web");
});

test("sparkWebBootScript imports the dsh runtime without a CLI spawn", () => {
  const script = sparkWebBootScript(["/tmp/patch-a.yml"], ["--trusted-host=127.0.0.1"]);
  assert.match(script, /@deepseek-ai\/dsh-app-boot/, "imports the stable app-boot runtime");
  assert.match(script, /profile-boot-/, "scans the dsh package for its boot entry");
  assert.match(script, /"\/tmp\/patch-a\.yml"/, "passes patch paths through");
  assert.match(script, /--trusted-host=127\.0\.0\.1/, "passes web args through");
  assert.doesNotMatch(script, /spawn\(/, "never shells out");
});

test("composeWebArgs carries port, trusted hosts, and forwards the rest", () => {
  const webArgs = composeWebArgs({
    host: undefined,
    port: 3100,
    trustedHosts: ["10.0.0.2"],
    argv: ["--flag"],
  });
  assert.deepEqual(webArgs, ["--port=3100", "--trusted-host=10.0.0.2", "--flag"]);
  assert.ok(!webArgs.some((arg) => arg === "--patch"), "no --patch argv anymore");
});
