import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  composeSparkWebPatch,
  composeWebArgs,
  ensureDshToolCueBundle,
  ensureSparkLlmBundle,
  ensureSparkWebClient,
  parseSparkWebArgs,
  prepareSparkWebDispatch,
  resolveDshProfileDir,
  resolveFromDirectory,
  resolveCueSkillsDir,
  resolveSparkLlmPackageDir,
  resolveSparkWebDshPackageDir,
  sparkWebBootErrorLines,
  sparkWebBootNodeArgs,
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

test("spark-web-dsh resolves its package root and verified source Skill snapshot", () => {
  const webDir = resolveSparkWebDshPackageDir();
  assert.ok(existsSync(join(webDir, "src", "client.tsx")), "client plugin entry exists");
  assert.ok(existsSync(join(webDir, "bin", "spark-web-dsh")), "spark-web-dsh executable exists");
  const skills = resolveCueSkillsDir(webDir);
  assert.ok(existsSync(join(skills, "cue", "SKILL.md")), "verified cue Skill snapshot exists");
  assert.ok(skills.endsWith(join("vendor", "cue", "skills")));
});

test("resolveDshProfileDir honors DSH_HOME", () => {
  assert.equal(resolveDshProfileDir("/tmp/dsh-home"), "/tmp/dsh-home/profiles/web");
});

test("sparkWebBootScript imports the dsh runtime without a CLI spawn", () => {
  const script = sparkWebBootScript(["/tmp/patch-a.yml"], ["--trusted-host=127.0.0.1"]);
  assert.match(script, /@deepseek-ai\/dsh-app-boot/, "imports the stable app-boot runtime");
  assert.match(script, /profile-boot-/, "scans the dsh package for its boot entry");
  assert.match(script, /\.sort\(\)\[0\]/, "picks the boot entry deterministically");
  assert.match(script, /"\/tmp\/patch-a\.yml"/, "passes patch paths through");
  assert.match(script, /--trusted-host=127\.0\.0\.1/, "passes web args through");
  assert.doesNotMatch(script, /spawn\(/, "never shells out");
});

test("sparkWebBootScript parses as a module and embeds the tested error serializer", () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-boot-"));
  try {
    const script = sparkWebBootScript(["/tmp/patch-a.yml"], ["--port=3080"]);
    const file = join(dir, "boot.mjs");
    writeFileSync(file, script);
    // Syntax-check the rendered artifact exactly as node will parse it.
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      script.includes(sparkWebBootErrorLines.toString()),
      "the child process runs the same serializer the tests cover",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sparkWebBootNodeArgs exposes Node internals for bare plugin specifier resolution", () => {
  assert.deepEqual(sparkWebBootNodeArgs("/profile/plugins/boot.mjs", "/dsh"), [
    "--expose-internals",
    "/profile/plugins/boot.mjs",
    "/dsh",
  ]);
});

test("sparkWebBootErrorLines flattens aggregate loader failures and their causes", () => {
  const missing = new Error("Cannot find package '@deepseek-ai/dsh-client-ui-goal'");
  const entry = new Error("failed to import loader entry ui-goal", { cause: missing });
  const aggregate = new AggregateError([entry], "loader entries failed to apply");
  const top = new Error("dsh: plugin tree failed to load", { cause: aggregate });
  assert.deepEqual(sparkWebBootErrorLines(top), [
    "dsh: plugin tree failed to load",
    "  loader entries failed to apply",
    "    failed to import loader entry ui-goal",
    "      Cannot find package '@deepseek-ai/dsh-client-ui-goal'",
  ]);
});

test("sparkWebBootErrorLines bounds output and tolerates cause cycles", () => {
  const cyclic = new Error("cyclic") as Error & { cause?: unknown };
  cyclic.cause = cyclic;
  const aggregate = new AggregateError([cyclic, new Error("sibling")], "many");
  const lines = sparkWebBootErrorLines(aggregate, 3);
  assert.equal(lines.length, 4, "three collected lines plus the truncation marker");
  assert.equal(lines.at(-1), "… (further nested failures truncated)");
});

test("ensureSparkWebClient links the package where the profile resolves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-client-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(profile, { recursive: true });
  try {
    const first = await ensureSparkWebClient(profile);
    const link = join(profile, "node_modules", "@zendev-lab", "spark-web-dsh");
    assert.ok(lstatSync(link).isSymbolicLink(), "single-scope symlink under the profile");
    assert.equal(realpathSync(link), realpathSync(first.packageDir));
    // The contract that matters: the package resolves from the profile root.
    const resolved = resolveFromDirectory(profile, "@zendev-lab/spark-web-dsh");
    assert.ok(resolved !== undefined && existsSync(resolved), "resolvable from the profile");

    // The legacy double-scope link from earlier builds is removed idempotently.
    const legacyScope = join(profile, "node_modules", "@zendev-lab", "@zendev-lab");
    mkdirSync(legacyScope, { recursive: true });
    symlinkSync(first.packageDir, join(legacyScope, "spark-web-dsh"), "junction");
    const second = await ensureSparkWebClient(profile);
    assert.equal(second.linked, false, "link already correct");
    assert.ok(!existsSync(legacyScope), "legacy nested scope directory removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSparkWebClient refuses to replace a real directory at the link target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-client-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "node_modules", "@zendev-lab", "spark-web-dsh"), { recursive: true });
  try {
    await assert.rejects(ensureSparkWebClient(profile), /exists and is not a symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
