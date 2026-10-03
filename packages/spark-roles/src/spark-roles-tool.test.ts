import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { registerSparkRolesTools } from "./extension.ts";
import { createDefaultRoleRegistry } from "./role-runtime.ts";

const DEFAULT_TEST_CWD = "/tmp/spark-roles-tool-default-cwd";

interface ToolConfig {
  name: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: {
      cwd?: string;
      modelRegistry?: unknown;
    },
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

test("role spec tools list, get, and create project roles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-spec-tools-"));
  try {
    const tools = registerRoleToolsForTest();
    assert.deepEqual([...tools.keys()].sort(), ["role"]);

    const created = await executeRoleTool(
      tools,
      "create_role",
      {
        id: "repo-inspector",
        description: "Inspect repository state before implementation.",
        systemPrompt: "You inspect repositories and report concise findings.",
        rationale: "Reusable inspection role for project work.",
        expectedUses: ["repo inspection"],
        capabilities: ["read"],
        modelType: "exploration",
      },
      dir,
    );
    assert.match(
      created.content[0]?.text ?? "",
      /Role created: repo-inspector \(role:project-[^)]+\)/,
    );

    const listed = await executeRoleTool(tools, "list_roles", { source: "project" }, dir);
    assert.match(listed.content[0]?.text ?? "", /repo-inspector/);

    const got = await executeRoleTool(tools, "get_role", { role: "repo-inspector" }, dir);
    assert.match(got.content[0]?.text ?? "", /systemPrompt: \d+ chars; preview=/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role action tool dispatches canonical list, get, and create actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-action-tool-"));
  try {
    const tools = registerRoleToolsForTest();
    assert.ok(tools.has("role"), "missing canonical role tool");

    const created = await executeRoleTool(
      tools,
      "role",
      {
        action: "create",
        id: "action-inspector",
        description: "Inspect repository state through the canonical role tool.",
        systemPrompt: "You inspect repositories and report concise findings.",
        rationale: "Reusable inspection role for project work.",
        expectedUses: ["repo inspection"],
        capabilities: ["read"],
        modelType: "exploration",
      },
      dir,
    );
    assert.match(created.content[0]?.text ?? "", /Role created: action-inspector/);

    const listed = await executeRoleTool(tools, "role", { action: "list", source: "project" }, dir);
    assert.match(listed.content[0]?.text ?? "", /action-inspector/);

    const got = await executeRoleTool(
      tools,
      "role",
      { action: "get", role: "action-inspector" },
      dir,
    );
    assert.match(got.content[0]?.text ?? "", /source: project/);

    assert.throws(
      () => executeRoleTool(tools, "role", { action: "send", toSessionId: "session:b" }, dir),
      /role\.action must be list, get, create, model_list/u,
    );
    assert.throws(
      () =>
        executeRoleTool(
          tools,
          "role",
          {
            action: "call",
            role: "executor",
            sessionId: "session:persistent",
            instruction: "Do not accept persistent session targets here.",
          },
          dir,
        ),
      /role\.action must be list, get, create, model_list/u,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("role action tool manages role model settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-model-action-tool-"));
  const previousBindingHome = process.env.SPARK_HOME;
  process.env.SPARK_HOME = dir;
  try {
    const tools = registerRoleToolsForTest();

    const saved = await executeRoleTool(
      tools,
      "role",
      {
        action: "model_set",
        role: "executor",
        model: "test/model",
        source: "project",
      },
      dir,
    );
    assert.match(
      saved.content[0]?.text ?? "",
      /Saved project model setting for type implementation/,
    );

    const got = await executeRoleTool(
      tools,
      "role",
      { action: "model_get", role: "executor" },
      dir,
    );
    assert.match(got.content[0]?.text ?? "", /test\/model source=project/);
    assert.equal(
      (got.details?.model as { modelType?: string } | undefined)?.modelType,
      "implementation",
    );

    const listed = await executeRoleTool(
      tools,
      "role",
      { action: "model_list", source: "project" },
      dir,
    );
    assert.match(listed.content[0]?.text ?? "", /implementation -> test\/model/);

    const deleted = await executeRoleTool(
      tools,
      "role",
      { action: "model_delete", role: "executor", source: "project" },
      dir,
    );
    assert.match(deleted.content[0]?.text ?? "", /Deleted project model setting/);

    const afterDelete = await executeRoleTool(
      tools,
      "role",
      { action: "model_get", role: "executor" },
      dir,
    );
    assert.match(afterDelete.content[0]?.text ?? "", /No model setting for type implementation/);

    await assert.rejects(
      executeRoleTool(
        tools,
        "role",
        {
          action: "model_set",
          role: "executor",
          model: "missing/model",
          source: "project",
        },
        dir,
      ),
      /model validation failed/,
    );
  } finally {
    if (previousBindingHome === undefined) delete process.env.SPARK_HOME;
    else process.env.SPARK_HOME = previousBindingHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("role schema has seven strict static-definition and model-setting actions", () => {
  const tools = registerRoleToolsForTest();
  const roleToolParameters = tools.get("role")?.parameters as
    | { anyOf?: Array<Record<string, unknown>>; unionOf?: Array<Record<string, unknown>> }
    | undefined;
  const branches = roleToolParameters?.anyOf ?? roleToolParameters?.unionOf ?? [];
  assert.equal(branches.length, 7);
  const branch = (action: string): Record<string, unknown> => {
    const match = branches.find((candidate) => {
      const properties = (candidate as { properties?: Record<string, unknown> }).properties ?? {};
      return (properties.action as { const?: string } | undefined)?.const === action;
    });
    assert.ok(match, `missing role action branch: ${action}`);
    return match;
  };
  const create = branch("create") as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
  };
  assert.equal(create.additionalProperties, false);
  assert.ok(create.properties?.modelType);
  assert.ok(create.properties?.skills);
  assert.equal("model" in (create.properties ?? {}), false);
  assert.equal("instruction" in (create.properties ?? {}), false);
  assert.equal(
    branches.some((candidate) => JSON.stringify(candidate).includes('"call"')),
    false,
  );
  assert.equal(tools.has("call_role"), false);

  const roles = createDefaultRoleRegistry({ now: "2026-01-01T00:00:00.000Z" }).list({
    source: "builtin",
  });
  assert.deepEqual(
    roles.map((role) => role.id),
    ["administrator", "executor", "explorer", "reviewer"],
  );
  assert.ok(roles.every((role) => role.source === "builtin" && role.revision.length > 0));
});

test("role spec tools keep patch presets out of builtin role lookup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spark-roles-no-patcher-"));
  try {
    const tools = registerRoleToolsForTest();
    const listed = await executeRoleTool(tools, "list_roles", { source: "builtin" }, dir);
    const roleIds = ((listed.details?.roles ?? []) as Array<{ id: string }>).map((role) => role.id);

    assert.deepEqual(roleIds, ["administrator", "executor", "explorer", "reviewer"]);
    assert.doesNotMatch(listed.content[0]?.text ?? "", /\bpatcher?\b/);
    await assert.rejects(
      executeRoleTool(tools, "get_role", { role: "patch" }, dir),
      /no role matches: patch/,
    );
    await assert.rejects(
      executeRoleTool(tools, "get_role", { role: "patcher" }, dir),
      /no role matches: patcher/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spark-roles tools require ctx cwd", async () => {
  const tools = registerRoleToolsForTest();

  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "list_roles", {}),
    /list_roles requires ctx\.cwd/,
  );
  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "get_role", { role: "executor" }),
    /get_role requires ctx\.cwd/,
  );
  await assert.rejects(
    executeRoleToolWithoutCwd(tools, "create_role", {
      id: "missing-cwd",
      description: "Should not write without a workspace.",
      systemPrompt: "Do not write this role.",
      rationale: "Project role writes require explicit workspace context.",
      expectedUses: ["validation"],
    }),
    /create_role requires ctx\.cwd/,
  );
});

test("spark-roles tools reject invalid explicit parameters instead of using defaults", async () => {
  const tools = registerRoleToolsForTest();

  await assert.rejects(
    executeRoleTool(tools, "list_roles", { limit: "many" }),
    /list_roles limit must be a finite number/,
  );
  await assert.rejects(
    executeRoleTool(tools, "list_roles", { source: "managed" }),
    /list_roles source must be builtin, extension, project, or user/,
  );

  await assert.rejects(
    executeRoleTool(tools, "get_role", { role: 42 }),
    /get_role role must be a string/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: 42,
      description: "Invalid role id should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
    }),
    /create_role id must be a string/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "missing-description",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
    }),
    /create_role description is required/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-source",
      description: "Invalid role source should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      source: "workspace",
    }),
    /create_role source must be project or user/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "extension-source",
      description: "Extension roles are package-registered, not user-created.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should reject extension writes.",
      expectedUses: ["validation"],
      source: "extension",
    }),
    /create_role source must be project or user/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-expected-uses",
      description: "Invalid expected uses should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["valid", 42],
    }),
    /create_role expectedUses must be an array of strings/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-allowed-tools",
      description: "Invalid allowed tools should fail.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      capabilities: ["read"],
      modelType: "implementation",
      allowedTools: ["read", 42],
    }),
    /create_role allowedTools must be an array of strings/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-model",
      description: "Model fields belong in role model settings.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      defaultModel: "test/model",
    }),
    /create_role defaultModel is not supported; use role model settings/,
  );
  await assert.rejects(
    executeRoleTool(tools, "create_role", {
      id: "bad-model-alias",
      description: "Model fields belong in role model settings.",
      systemPrompt: "Do not write this role.",
      rationale: "Parameter validation should be explicit.",
      expectedUses: ["validation"],
      model: "test/model",
    }),
    /create_role model is not supported; use role model settings/,
  );
});

function registerRoleToolsForTest(): Map<string, ToolConfig> {
  const tools = new Map<string, ToolConfig>();
  registerSparkRolesTools({
    registerTool: (config) => tools.set(config.name, config as ToolConfig),
  });
  return tools;
}

function executeRoleTool(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
  cwd = DEFAULT_TEST_CWD,
  ctxExtra: { modelRegistry?: unknown } = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const call = canonicalRoleToolCall(name, params);
  const tool = tools.get(call.name);
  assert.ok(tool, `missing ${call.name} tool`);
  return tool.execute("tool-call", call.params, new AbortController().signal, () => undefined, {
    cwd,
    modelRegistry: testModelRegistry(),
    ...ctxExtra,
  });
}

function testModelRegistry(): {
  getAll(): Array<{ provider: string; id: string }>;
  getAvailable(): Array<{ provider: string; id: string }>;
} {
  const models = [{ provider: "test", id: "model" }];
  return {
    getAll: () => models,
    getAvailable: () => models,
  };
}

function executeRoleToolWithoutCwd(
  tools: Map<string, ToolConfig>,
  name: string,
  params: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
  const call = canonicalRoleToolCall(name, params);
  const tool = tools.get(call.name);
  assert.ok(tool, `missing ${call.name} tool`);
  return tool.execute("tool-call", call.params, new AbortController().signal, () => undefined, {});
}

function canonicalRoleToolCall(
  name: string,
  params: Record<string, unknown>,
): { name: "role"; params: Record<string, unknown> } {
  switch (name) {
    case "role":
      return { name, params };
    case "list_roles":
      return { name: "role", params: { action: "list", ...params } };
    case "get_role":
      return { name: "role", params: { action: "get", ...params } };
    case "create_role":
      return { name: "role", params: { action: "create", ...params } };
    case "model_list_roles":
      return { name: "role", params: { action: "model_list", ...params } };
    case "model_get_role":
      return { name: "role", params: { action: "model_get", ...params } };
    case "model_set_role":
      return { name: "role", params: { action: "model_set", ...params } };
    case "model_delete_role":
      return { name: "role", params: { action: "model_delete", ...params } };
    default:
      throw new Error(`unknown test role tool: ${name}`);
  }
}
