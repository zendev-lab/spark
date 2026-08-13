import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import {
  BUILTIN_ROLE_CAPABILITY_PROFILES,
  ROLE_CAPABILITY_VOCAB,
  RoleRegistry,
  MarkdownRoleStore,
  builtinRoleAllowedTools,
  builtinRoleAllowedToolEffects,
  createExtensionRoleSpec,
  createRoleSpec,
  createBuiltinRoles,
  hydrateDefaultRoleRegistry,
  builtinRoleIds,
  hydrateExtensionRoles,
  listExtensionRoles,
  registerExtensionRole,
  validateBuiltinRoleProfiles,
} from "@zendev-lab/spark-roles";

test("builtin Administrator coordinates and delegates without execution tools", () => {
  const roles = createBuiltinRoles();
  const administrator = roles.find((role) => role.id === "administrator");
  assert.ok(administrator);
  assert.deepEqual(administrator.allowedToolEffects, ["read", "local_write", "external_write"]);
  assert.equal(administrator.allowedTools?.includes("session"), true);
  assert.equal(administrator.allowedTools?.includes("role"), true);
  assert.equal(administrator.allowedTools?.includes("repro"), true);
  for (const forbidden of [
    "cue_exec",
    "cue_run",
    "cue_script",
    "script_run",
    "script_eval",
    "cue_jobs",
    "edit",
    "write",
    "web_search",
  ]) {
    assert.equal(administrator?.allowedTools?.includes(forbidden), false);
  }
});

test("builtin Pi roles expose audited capability profiles", () => {
  const roles = createBuiltinRoles("2026-06-04T00:00:00.000Z");
  assert.deepEqual(
    roles.map((role) => role.id),
    [...builtinRoleIds],
  );
  assert.deepEqual(
    [...ROLE_CAPABILITY_VOCAB],
    ["read", "write", "exec", "net", "interact", "manage", "spawn"],
  );
  assert.equal(ROLE_CAPABILITY_VOCAB.includes("record" as never), false);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.administrator, [
    "read",
    "interact",
    "manage",
    "spawn",
  ]);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.explorer, ["read", "net"]);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.reviewer, ["read", "net"]);
  assert.deepEqual(BUILTIN_ROLE_CAPABILITY_PROFILES.executor, ["read", "net", "exec", "write"]);

  const profileIncludes = (roleId: keyof typeof BUILTIN_ROLE_CAPABILITY_PROFILES, value: string) =>
    (BUILTIN_ROLE_CAPABILITY_PROFILES[roleId] as readonly string[]).includes(value);
  for (const roleId of builtinRoleIds) {
    if (roleId !== "administrator") {
      assert.equal(profileIncludes(roleId, "interact"), false);
      assert.equal(profileIncludes(roleId, "spawn"), false);
    }
    assert.equal(profileIncludes(roleId, "record"), false);
  }

  const byId = new Map(roles.map((role) => [role.id, role]));

  assert.deepEqual(byId.get("reviewer")?.allowedTools, builtinRoleAllowedTools("reviewer"));

  assert.deepEqual(byId.get("explorer")?.allowedTools, builtinRoleAllowedTools("explorer"));

  assert.deepEqual(byId.get("executor")?.allowedTools, builtinRoleAllowedTools("executor"));
  assert.deepEqual(byId.get("administrator")?.allowedTools, [
    "read",
    "grep",
    "find",
    "context",
    "ask",
    "session",
    "task_read",
    "task_write",
    "goal",
    "workflow",
    "repro",
    "role",
    "assign",
    "delegation",
  ]);
  assert.deepEqual(builtinRoleAllowedToolEffects("administrator"), [
    "read",
    "local_write",
    "external_write",
  ]);
  assert.deepEqual(builtinRoleAllowedToolEffects("explorer"), ["read", "network_read"]);
  assert.deepEqual(builtinRoleAllowedToolEffects("reviewer"), ["read", "network_read"]);
  assert.deepEqual(builtinRoleAllowedToolEffects("executor"), [
    "read",
    "network_read",
    "local_write",
    "external_write",
  ]);

  const forbiddenTools = new Set([
    "ask",
    "ask_user",
    "ask_flow",
    "task",
    "task_read",
    "task_write",
    "goal",
    "role",
    "assign",
    "workflow",
    "graft_patch",
  ]);
  for (const role of roles.filter((candidate) => candidate.id !== "administrator")) {
    for (const tool of role.allowedTools ?? []) assert.equal(forbiddenTools.has(tool), false);
  }
  validateBuiltinRoleProfiles(roles);
});

test("retired builtin role aliases fail closed after registry v6", () => {
  const registry = new RoleRegistry(createBuiltinRoles());
  assert.throws(() => registry.select("builtin-scout"), /retired builtin role ref/u);
  assert.throws(() => registry.select("role:builtin-scout"), /retired builtin role ref/u);
  assert.throws(() => registry.select("builtin-worker"), /retired builtin role ref/u);
  assert.throws(() => registry.select("role:builtin-worker"), /retired builtin role ref/u);
  assert.equal(
    registry.list().some((role) => role.id === "scout" || role.id === "worker"),
    false,
  );
});

test("extension role specs hydrate separately from writable project/user stores", async () => {
  const role = createExtensionRoleSpec(
    {
      id: "test-extension-patcher",
      description: "Test extension patcher role.",
      systemPrompt: "Use only extension-provided patch tools.",
      capabilities: ["read", "write"],
      modelType: "implementation",
      allowedTools: ["graft_read", "graft_write"],
      origin: { kind: "extension", note: "test" },
    },
    "2026-06-04T00:00:00.000Z",
  );

  registerExtensionRole(role);
  assert.equal(role.ref, "role:extension-test-extension-patcher");
  assert.equal(role.source, "extension");
  assert.ok(listExtensionRoles().some((candidate) => candidate.ref === role.ref));

  const registry = new RoleRegistry([]);
  hydrateExtensionRoles(registry);
  assert.equal(registry.select("test-extension-patcher", { source: "extension" }).ref, role.ref);

  const store = new MarkdownRoleStore({ rootDir: "/tmp/no-write-extension", source: "project" });
  await assert.rejects(() => store.save(role), /only project roles can be saved/);
});

test("project role spec store persists and hydrates registry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-"));
  try {
    const store = new MarkdownRoleStore(dir);
    const spec = createRoleSpec({
      id: "svg-assembler",
      description: "Creates SVG assembly animation plans.",
      systemPrompt: "You are a specialist in SVG animation planning.",
      rationale: "We need a narrow reusable specialist for SVG animation tasks.",
      expectedUses: ["svg assembly planning", "animation decomposition"],
      capabilities: ["read"],
      modelType: "implementation",
    });
    await store.save(spec);

    const registry = new RoleRegistry();
    await store.hydrate(registry);
    const loaded = registry.select("svg-assembler");

    assert.equal(loaded.source, "project");
    assert.equal(loaded.id, "svg-assembler");
    assert.match(loaded.ref, /^role:project-/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markdown role store ignores foreign subagent specs in shared .agents roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-"));
  try {
    await writeFile(
      join(dir, "coder.md"),
      `---\nname: coder\ndescription: >-\n  External subagent spec.\nrole: subagent\nmodel:\n  tier: coding\ncapabilities:\n  - basic\n---\nYou are coder.\n`,
      "utf8",
    );
    const store = new MarkdownRoleStore({ rootDir: dir, source: "user" });

    assert.deepEqual(await store.loadAll(), []);
    const registry = new RoleRegistry();
    await store.hydrate(registry);
    assert.throws(() => registry.select("coder", { source: "user" }), /no role matches/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("markdown role store still rejects Pi role specs with model frontmatter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-"));
  try {
    await writeFile(
      join(dir, "bad.md"),
      `---\nid: bad\ndescription: Invalid Pi role.\nmodel: test/model\n---\nYou are invalid.\n`,
      "utf8",
    );
    const store = new MarkdownRoleStore(dir);

    await assert.rejects(
      () => store.loadAll(),
      /role spec model fields are not supported; use role model settings/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default role hydration applies workspace then cwd precedence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-role-precedence-"));
  try {
    const repo = join(dir, "repo");
    const cwd = join(repo, "nested");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".agents", "roles"), { recursive: true });
    await mkdir(join(cwd, ".agents", "roles"), { recursive: true });
    const markdown = (description: string) =>
      `---\nid: shared\ndescription: ${description}\ncapabilities:\n  - read\nmodelType: implementation\n---\nUse this role.\n`;
    await writeFile(join(repo, ".agents", "roles", "shared.md"), markdown("workspace"), "utf8");
    await writeFile(join(cwd, ".agents", "roles", "shared.md"), markdown("cwd"), "utf8");

    const registry = new RoleRegistry([]);
    await hydrateDefaultRoleRegistry(registry, cwd, { includeUser: false });

    assert.equal(registry.select("shared").description, "cwd");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
