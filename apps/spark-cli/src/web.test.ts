import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { parseSparkDispatcherArgs } from "./cli.ts";
import {
  composeSparkWebPatch,
  ensureSparkLlmBundle,
  parseSparkWebArgs,
  resolveDshProfileDir,
  resolveSparkLlmPackageDir,
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

test("spark-llm package resolves from the workspace and exposes the plugin entry", () => {
  const llmDir = resolveSparkLlmPackageDir();
  assert.ok(existsSync(join(llmDir, "src", "dsh-plugin.ts")), "plugin entry exists");
});

test("resolveDshProfileDir honors DSH_HOME", () => {
  assert.equal(resolveDshProfileDir("/tmp/dsh-home"), "/tmp/dsh-home/profiles/web");
});
