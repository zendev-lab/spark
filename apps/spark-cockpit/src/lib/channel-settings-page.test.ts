import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, parse } from "svelte/compiler";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(root, "../routes/(console)/[workspaceId]/settings/channels/+page.svelte");
const serverPath = resolve(
  root,
  "../routes/(console)/[workspaceId]/settings/channels/+page.server.ts",
);

function source(path: string) {
  return readFileSync(path, "utf8");
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) if (key !== "parent") walk(child, visit);
}

function textAttribute(node: Record<string, unknown>) {
  const value = node.value as Array<{ data?: unknown }> | undefined;
  return value?.length === 1 && typeof value[0]?.data === "string" ? value[0].data : undefined;
}

describe("channel settings page contract", () => {
  it("compiles and exposes a fresh account connection editor", () => {
    const page = source(pagePath);
    expect(() => compile(page, { filename: pagePath, generate: "server" })).not.toThrow();
    const ast = parse(page, { modern: true });
    const functions = new Set<string>();
    const calls = new Set<string>();
    const actions: string[] = [];
    const clickHandlers = new Set<string>();
    walk(ast, (node) => {
      if (node.type === "FunctionDeclaration") {
        const id = node.id as { name?: unknown } | undefined;
        if (typeof id?.name === "string") functions.add(id.name);
      }
      if (node.type === "CallExpression") {
        const callee = node.callee as { name?: unknown } | undefined;
        if (typeof callee?.name === "string") calls.add(callee.name);
      }
      if (node.type === "Attribute" && node.name === "action") {
        const value = textAttribute(node);
        if (value) actions.push(value);
      }
      if (node.type === "Attribute" && node.name === "onclick") {
        const value = node.value as { expression?: { name?: unknown } } | undefined;
        if (typeof value?.expression?.name === "string") clickHandlers.add(value.expression.name);
      }
    });

    expect(functions.has("startConnectPlatform")).toBe(true);
    expect(calls.has("freshMessagePlatformFormValues")).toBe(true);
    expect(calls.has("freshPlatformValues")).toBe(true);
    expect(actions).toEqual([
      "?/savePlatform",
      "?/startQqbotQrAuth",
      "?/qqbotQrAuthStatus",
      "?/cancelQqbotQrAuth",
    ]);
    expect(clickHandlers).toEqual(new Set(["startConnectPlatform"]));
  });

  it("renders adapter accounts without session binding fields", () => {
    const ast = parse(source(pagePath), { modern: true });
    const eachSources = new Set<string>();
    const inputNames = new Set<string>();
    const textExpressions = new Set<string>();
    const anchorHrefs = new Set<string>();
    walk(ast.fragment, (node) => {
      if (node.type === "EachBlock") {
        const expression = node.expression as { name?: unknown } | undefined;
        if (typeof expression?.name === "string") eachSources.add(expression.name);
      }
      if (node.type === "Attribute" && node.name === "name") {
        const value = textAttribute(node);
        if (value) inputNames.add(value);
      }
      if (node.type === "Attribute" && node.name === "href") {
        const value = textAttribute(node);
        if (value) anchorHrefs.add(value);
      }
      if (node.type === "MemberExpression") {
        const object = node.object as { name?: unknown } | undefined;
        const property = node.property as { name?: unknown } | undefined;
        if (typeof object?.name === "string" && typeof property?.name === "string") {
          textExpressions.add(`${object.name}.${property.name}`);
        }
      }
    });

    expect(eachSources.has("platforms")).toBe(true);
    expect(textExpressions.has("platform.accountId")).toBe(true);
    expect(textExpressions.has("t.accountIdLabel")).toBe(true);
    expect(inputNames.has("adapter")).toBe(true);
    expect(inputNames.has("scope")).toBe(false);
    expect(inputNames.has("externalId")).toBe(false);
    expect(inputNames.has("formatter")).toBe(false);
    expect(inputNames.has("bindings")).toBe(false);
    expect(anchorHrefs.has("/sessions")).toBe(false);
  });

  it("saves account configuration without managed-session mutations", () => {
    const server = ts.createSourceFile(
      serverPath,
      source(serverPath),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const calls = new Set<string>();
    const actionNames = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        calls.add(node.expression.text);
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name))
        actionNames.add(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(server);

    expect(actionNames.has("savePlatform")).toBe(true);
    expect(actionNames.has("startQqbotQrAuth")).toBe(true);
    expect(actionNames.has("qqbotQrAuthStatus")).toBe(true);
    expect(actionNames.has("cancelQqbotQrAuth")).toBe(true);
    expect(calls.has("saveChannelsConfigForCockpit")).toBe(true);
    expect(calls.has("requireSecretRequestContext")).toBe(true);
    expect(calls.has("createManagedSessionForCockpit")).toBe(false);
    expect(calls.has("bindManagedSessionForCockpit")).toBe(false);
    expect(calls.has("archiveManagedSessionForCockpit")).toBe(false);
    expect(calls.has("createChannelExternalKey")).toBe(false);
  });

  it("renders QR locally while keeping returned QQ secrets daemon-owned", () => {
    const page = source(pagePath);
    const server = source(serverPath);

    expect(page).toContain("qqbotQrImageAlt");
    expect(page).toContain("?/qqbotQrAuthStatus");
    expect(server).toContain("renderSVG(flow.qrCodeUrl");
    expect(server).toContain("createCockpitRuntimeModelChannelClient().startQqbotQrAuth");
    expect(server).toContain("appId: flow.appId");
    expect(server).not.toContain("clientSecret: flow");
    expect(server).not.toContain("appSecret: flow");
  });
});
