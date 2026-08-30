import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { cueSkillsRoot } from "@zendev-lab/cue";

import { installManagedCuePresets } from "./cue-presets.ts";
import {
  composeSparkWebPatch,
  composeWebArgs,
  ensureDshCueBundle,
  ensureDshToolCueBundle,
  ensureDshToolFusionBundle,
  ensureDshToolWebBundle,
  ensureDshWebProviderBundle,
  ensureDshWebProfile,
  ensureSparkFilesBundle,
  ensureSparkLlmBundle,
  ensureSparkPrivateWebServerBundle,
  ensureSparkSessionSubagentBundle,
  ensureSparkWebClient,
  parseSparkWebArgs,
  prepareSparkWebDispatch,
  resolveDshProfileDir,
  resolveDshCuePackageDir,
  resolveDshToolWebPackageDir,
  resolveFromDirectory,
  resolveCueSkillsDir,
  resolveSparkFilesPackageDir,
  resolveSparkLlmPackageDir,
  resolveSparkSessionPackageDir,
  resolveSparkWebDshPackageDir,
  sparkWebBootErrorLines,
  sparkWebBootNodeArgs,
  sparkWebBootScript,
  sparkWebDshBrowserUrls,
  sparkWebDshListeningText,
  waitForSparkWebDshReady,
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
  assert.deepEqual(parseSparkWebArgs(["--port=8081"]), {
    host: undefined,
    port: 8081,
    trustedHosts: [],
    argv: [],
  });
  assert.deepEqual(parseSparkWebArgs([]), {
    host: undefined,
    port: undefined,
    trustedHosts: [],
    argv: [],
  });
  assert.throws(() => parseSparkWebArgs(["--port", "abc"]), /must be a number/);
  assert.throws(() => parseSparkWebArgs(["--port=65536"]), /between 1 and 65535/u);
  assert.throws(() => parseSparkWebArgs(["--host"]), /requires a value/);
});

test("web-dsh prints reachable wildcard URLs and its daemon-issued startup token", () => {
  const urls = sparkWebDshBrowserUrls({ host: "0.0.0.0", port: 3080 }, ["192.168.1.5"]);
  assert.deepEqual(urls, ["http://127.0.0.1:3080/", "http://192.168.1.5:3080/"]);
  assert.equal(
    sparkWebDshListeningText(urls, "sdu_abcdefghijklmnopqrstuvwxyz123456"),
    `Spark web-dsh listening:
  http://127.0.0.1:3080/?token=sdu_abcdefghijklmnopqrstuvwxyz123456
  http://192.168.1.5:3080/?token=sdu_abcdefghijklmnopqrstuvwxyz123456
Startup access token:
  sdu_abcdefghijklmnopqrstuvwxyz123456
Spark revokes this token during normal shutdown.
`,
  );
});

test("web-dsh waits for the credential-guarded private page before announcing readiness", async () => {
  const credential = "private-test-credential";
  const server = createHttpServer((request, response) => {
    if (request.headers["x-spark-web-dsh-proxy"] !== credential) {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200).end("ready");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await waitForSparkWebDshReady(address.port, credential);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

test("composeSparkWebPatch replaces stock providers, mounts Spark DSH plugins, and bounds the long-lived web server", () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-patch-"));
  try {
    const defaultPatch = composeSparkWebPatch(dir);
    const defaultText = defaultPatch.rows.join("\n");
    assert.match(defaultText, /- id: spark-llm/);
    assert.match(defaultText, /name: \.\/plugins\/spark-llm\/index\.mjs/);
    assert.match(defaultText, /- id: llm-pi-ai\n  disabled: true/);
    assert.match(defaultText, /- id: spark-web-dsh/);
    assert.match(defaultText, /- id: dsh-cue/);
    assert.match(defaultText, /name: \.\/plugins\/dsh-cue\/index\.mjs/);
    assert.match(defaultText, /- id: dsh-tool-cue/);
    assert.match(defaultText, /name: \.\/plugins\/dsh-tool-cue\/index\.mjs/);
    assert.match(defaultText, /- id: dsh-tool-fusion/);
    assert.match(defaultText, /name: \.\/plugins\/dsh-tool-fusion\/index\.mjs/);
    assert.match(defaultText, /- id: dsh-web-provider/);
    assert.match(defaultText, /name: \.\/plugins\/dsh-web-provider\/index\.mjs/);
    assert.match(defaultText, /- id: spark-session-subagent/);
    assert.match(defaultText, /name: \.\/plugins\/spark-session-subagent\/index\.mjs/);
    assert.match(defaultText, /- id: spark-base-tool-fs/);
    assert.match(defaultText, /name: '@deepseek-ai\/dsh-tool-fs'/);
    assert.match(defaultText, /- id: agent-presets\n  config:\n    default: spark-standard/);
    assert.match(defaultText, /name: ["']@zendev-lab\/spark-web-dsh["']/);
    assert.match(defaultText, /- id: hmr\n  disabled: true/);
    assert.match(
      defaultText,
      /- id: spark-private-webserver\n      name: \.\/plugins\/spark-private-webserver\/index\.mjs\n      inject: \[webStartup\]\n      config:\n        host: 127\.0\.0\.1\n        port: !!js ctx\.webStartup\.port \?\? 3080/,
    );
    assert.match(
      defaultText,
      /- id: webserver\n  name: '@deepseek-ai\/dsh-host-webserver'\n  disabled: true/,
    );
    assert.ok(existsSync(defaultPatch.path), "patch file written");

    writeFileSync(
      join(dir, "cordis.patch.yml"),
      "- insert:\n    - id: spark-session-subagent\n      name: ./plugins/spark-session-subagent/index.mjs\n",
    );
    const skipped = composeSparkWebPatch(dir).rows.join("\n");
    assert.doesNotMatch(skipped, /- id: spark-session-subagent/);
    assert.match(skipped, /- id: spark-llm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private WebServer bundle extends the installed DSH service with credential guards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-private-webserver-"));
  const profile = join(dir, "profiles", "web");
  try {
    const bundle = await ensureSparkPrivateWebServerBundle(profile);
    const source = readFileSync(bundle, "utf8");
    assert.match(source, /@deepseek-ai\/dsh-host-webserver/u);
    assert.match(source, /x-spark-web-dsh-proxy/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("private WebServer bundle installs from a packaged entry without source files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-private-webserver-package-"));
  const profile = join(dir, "profile");
  const packageDir = join(dir, "package");
  const packagedEntry = join(packageDir, "lib", "spark-private-webserver.mjs");
  try {
    mkdirSync(dirname(packagedEntry), { recursive: true });
    writeFileSync(packagedEntry, 'export default "packaged-private-webserver";\n');
    const bundle = await ensureSparkPrivateWebServerBundle(profile, packageDir);
    assert.equal(readFileSync(bundle, "utf8"), readFileSync(packagedEntry, "utf8"));
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

test("ensureSparkSessionSubagentBundle builds the plugin bundle into the profile and is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-web-subagent-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureSparkSessionSubagentBundle(profile);
    assert.ok(existsSync(first.bundle), "bundle written");
    assert.ok(
      existsSync(join(profile, "plugins", "spark-session-subagent", "index.mjs")),
      "mount file written",
    );
    assert.equal(first.rebuilt, true);

    const second = await ensureSparkSessionSubagentBundle(profile);
    assert.equal(second.rebuilt, false, "no rebuild when the bundle is newer than the source");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDshCueBundle installs the execution service idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-cue-service-bundle-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureDshCueBundle(profile);
    assert.equal(first.rebuilt, true);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(first.bundle));
    assert.ok(existsSync(join(profile, "plugins", "dsh-cue", ".source-sha256")));

    const second = await ensureDshCueBundle(profile);
    assert.equal(second.rebuilt, false);
    assert.equal(second.sourceDigest, first.sourceDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDshToolCueBundle uses a source digest and never writes the source checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tool-cue-bundle-"));
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

test("ensureDshToolFusionBundle installs the Fusion plugin idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-fusion-bundle-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureDshToolFusionBundle(profile);
    assert.equal(first.rebuilt, true);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(first.bundle));
    assert.ok(existsSync(join(profile, "plugins", "dsh-tool-fusion", ".source-sha256")));

    const second = await ensureDshToolFusionBundle(profile);
    assert.equal(second.rebuilt, false);
    assert.equal(second.sourceDigest, first.sourceDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDshToolWebBundle installs the per-agent Web tools idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-tool-web-bundle-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureDshToolWebBundle(profile);
    assert.equal(first.rebuilt, true);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(first.bundle));
    assert.ok(existsSync(join(profile, "plugins", "dsh-tool-web", ".source-sha256")));

    const second = await ensureDshToolWebBundle(profile);
    assert.equal(second.rebuilt, false);
    assert.equal(second.sourceDigest, first.sourceDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDshWebProviderBundle installs the host ctx.web providers idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-web-provider-bundle-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureDshWebProviderBundle(profile);
    assert.equal(first.rebuilt, true);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(first.bundle));
    assert.ok(existsSync(join(profile, "plugins", "dsh-web-provider", ".source-sha256")));

    const second = await ensureDshWebProviderBundle(profile);
    assert.equal(second.rebuilt, false);
    assert.equal(second.sourceDigest, first.sourceDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureSparkFilesBundle installs the owner adapter idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "spark-files-bundle-"));
  const profile = join(dir, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  try {
    const first = await ensureSparkFilesBundle(profile);
    assert.equal(first.rebuilt, true);
    assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
    assert.ok(existsSync(first.bundle));
    assert.ok(existsSync(join(profile, "plugins", "spark-files", ".source-sha256")));

    const second = await ensureSparkFilesBundle(profile);
    assert.equal(second.rebuilt, false);
    assert.equal(second.sourceDigest, first.sourceDigest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed presets reference the profile-owned file and Web bundles", async () => {
  const home = mkdtempSync(join(tmpdir(), "spark-web-preset-files-"));
  const profile = join(home, "profiles", "web");
  mkdirSync(join(profile, "plugins"), { recursive: true });
  const dshPackageDir = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "presets",
    "upstream-package",
  );
  try {
    const files = await ensureSparkFilesBundle(profile);
    const web = await ensureDshToolWebBundle(profile);
    for (const preset of installManagedCuePresets(home, dshPackageDir, cueSkillsRoot)) {
      const composition = readFileSync(join(preset.path, "agent.cordis.yml"), "utf8");
      const specifier = /^- id: tool-fs\n  name: "([^"]+)"$/m.exec(composition)?.[1];
      assert.ok(specifier !== undefined, "preset names a tool-fs adapter");
      // The installed preset directory travels with DSH_HOME, so the
      // preset-relative specifier must land on the profile plugin bundle.
      assert.equal(resolve(preset.path, specifier), files.bundle);
      const webSpecifier = /^- id: tool-web\n  name: "([^"]+)"$/m.exec(composition)?.[1];
      assert.ok(webSpecifier !== undefined, "preset names the local Web tool plugin");
      assert.equal(resolve(preset.path, webSpecifier), web.bundle);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("spark-llm-providers package resolves from the workspace and exposes the plugin entry", () => {
  const llmDir = resolveSparkLlmPackageDir();
  assert.ok(existsSync(join(llmDir, "src", "dsh-plugin.ts")), "plugin entry exists");
});

test("spark-session package resolves from the workspace and exposes the subagent plugin entry", () => {
  const sessionDir = resolveSparkSessionPackageDir();
  assert.ok(existsSync(join(sessionDir, "src", "subagent.ts")), "plugin entry exists");
});

test("spark-files package resolves from the workspace and exposes the DSH adapter", () => {
  const filesDir = resolveSparkFilesPackageDir();
  assert.ok(existsSync(join(filesDir, "src", "dsh-plugin.ts")), "DSH adapter exists");
});

test("dsh-tool-web resolves from the workspace and exposes tool and provider plugins", () => {
  const webDir = resolveDshToolWebPackageDir();
  assert.ok(existsSync(join(webDir, "src", "index.ts")), "tool plugin entry exists");
  assert.ok(existsSync(join(webDir, "src", "provider.ts")), "provider plugin entry exists");
});

test("dsh-cue resolves its package root and exposes the Cordis plugin", () => {
  const cueDir = resolveDshCuePackageDir();
  assert.ok(existsSync(join(cueDir, "src", "plugin.ts")), "Cordis plugin entry exists");
});

test("spark-web-dsh resolves its package root and package-owned Cue Skill", () => {
  const webDir = resolveSparkWebDshPackageDir();
  assert.ok(existsSync(join(webDir, "src", "client.tsx")), "client plugin entry exists");
  assert.ok(existsSync(join(webDir, "bin", "spark-web-dsh")), "spark-web-dsh executable exists");
  const skills = resolveCueSkillsDir();
  assert.ok(existsSync(join(skills, "cue", "SKILL.md")), "package-owned cue Skill exists");
  assert.equal(realpathSync(skills), realpathSync(cueSkillsRoot));
});

test("resolveCueSkillsDir fails closed for a missing or linked Skill", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-cue-skill-"));
  try {
    assert.throws(() => resolveCueSkillsDir(join(dir, "missing")), /package-owned Cue Skill/u);
    mkdirSync(join(dir, "cue"));
    symlinkSync(join(cueSkillsRoot, "cue", "SKILL.md"), join(dir, "cue", "SKILL.md"));
    assert.throws(() => resolveCueSkillsDir(dir), /package-owned Cue Skill/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDshProfileDir honors DSH_HOME", () => {
  assert.equal(resolveDshProfileDir("/tmp/dsh-home"), "/tmp/dsh-home/profiles/web");
});

test("ensureDshWebProfile initializes a missing profile and preserves its user patch", async () => {
  const home = mkdtempSync(join(tmpdir(), "spark-web-dsh-profile-"));
  const profile = join(home, "profiles", "web");
  const dshPackageDir = join(home, "installed", "@deepseek-ai", "dsh");
  const appBootDir = join(dshPackageDir, "node_modules", "@deepseek-ai", "dsh-app-boot");
  try {
    mkdirSync(join(appBootDir, "lib"), { recursive: true });
    writeFileSync(
      join(dshPackageDir, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh", version: "fixture-release" }),
    );
    writeFileSync(
      join(appBootDir, "package.json"),
      JSON.stringify({
        name: "@deepseek-ai/dsh-app-boot",
        type: "module",
        main: "lib/index.js",
      }),
    );
    writeFileSync(
      join(appBootDir, "lib", "index.js"),
      `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const PROFILE_TEMPLATES = {
  web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
};

export function healProfilesModuleFallback(_anchor, dshHome) {
  const dir = join(dshHome, "profiles", "node_modules");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".healed"), "ok\\n");
}

export function initProfile(dir, bundles) {
  mkdirSync(dir, { recursive: true });
  const files = {
    "package.json": JSON.stringify({
      name: \`dsh-profile-\${basename(dir)}\`,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles } },
    }, undefined, 2) + "\\n",
    "cordis.patch.yml": "[]\\n",
    "pnpm-workspace.yaml": "packages:\\n  - .\\n",
  };
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    if (!existsSync(path)) writeFileSync(path, contents);
  }
}

export function loadProfile(_binName, name, _anchor, dshHome) {
  const dir = join(dshHome, "profiles", name);
  for (const file of ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"]) {
    if (!existsSync(join(dir, file))) throw new Error(\`missing profile file: \${file}\`);
  }
  return { dir };
}
`,
    );

    assert.equal(await ensureDshWebProfile(profile, dshPackageDir), true);
    const manifest = JSON.parse(readFileSync(join(profile, "package.json"), "utf8")) as {
      dsh: { profile: { bundles: string[] } };
    };
    assert.deepEqual(manifest.dsh.profile.bundles, [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
    ]);
    assert.ok(existsSync(join(profile, "pnpm-workspace.yaml")));
    assert.ok(existsSync(join(home, "profiles", "node_modules", ".healed")));

    const userPatch = "- id: user-plugin\n  disabled: true\n";
    writeFileSync(join(profile, "cordis.patch.yml"), userPatch);
    assert.equal(await ensureDshWebProfile(profile, dshPackageDir), false);
    assert.equal(readFileSync(join(profile, "cordis.patch.yml"), "utf8"), userPatch);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("sparkWebBootScript imports the dsh runtime without a CLI spawn", () => {
  const script = sparkWebBootScript(["/tmp/patch-a.yml"], ["--trusted-host=127.0.0.1"]);
  assert.match(script, /@deepseek-ai\/dsh-app-boot/, "imports the stable app-boot runtime");
  assert.match(script, /profile-boot-/, "scans the dsh package for its boot entry");
  assert.match(script, /\.sort\(\)\[0\]/, "picks the boot entry deterministically");
  assert.match(script, /"\/tmp\/patch-a\.yml"/, "passes patch paths through");
  assert.match(script, /--trusted-host=127\.0\.0\.1/, "passes web args through");
  assert.match(script, /readFileSync\(3, "utf8"\)/u, "receives the credential over a pipe");
  assert.match(script, /private-proxy-credential/u, "hands it only to the private adapter");
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

test("composeWebArgs disables browser launch and forwards the remaining web arguments", () => {
  const webArgs = composeWebArgs({
    host: undefined,
    port: 3100,
    trustedHosts: ["10.0.0.2"],
    argv: ["--flag"],
  });
  assert.deepEqual(webArgs, ["--port=3100", "--no-open", "--trusted-host=10.0.0.2", "--flag"]);
  assert.ok(!webArgs.some((arg) => arg === "--patch"), "no --patch argv anymore");
});
