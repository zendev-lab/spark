import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "svelte/compiler";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getDictionary } from "./i18n";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (path: string) => readFileSync(join(appRoot, path), "utf8");

type Node = Record<string, unknown>;

function walk(value: unknown, visit: (node: Node) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as Node;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) if (key !== "parent") walk(child, visit);
}

describe("conversation i18n boundary", () => {
  it("resolves conversation workbench copy from locale dictionaries", () => {
    const english = getDictionary("en").sessions;
    const chinese = getDictionary("zh-CN").sessions;

    expect(english).not.toEqual(chinese);
    expect(Object.keys(english).sort()).toEqual(Object.keys(chinese).sort());
    expect(english.title).not.toBe(chinese.title);
  });

  it("derives SessionsWorkspace workbench copy without local language branching", () => {
    const ast = parse(source("src/lib/SessionsWorkspace.svelte"), { modern: true });
    const derivedChains = new Set<string>();
    const identifiers = new Set<string>();
    const cjkLiterals: string[] = [];
    // eslint-disable-next-line complexity -- one AST visitor classifies the complete locale ownership contract.
    walk(ast.instance, (node) => {
      if (node.type === "Identifier" && typeof node.name === "string") identifiers.add(node.name);
      if (
        node.type === "Literal" &&
        typeof node.value === "string" &&
        /[\u3400-\u9fff]/u.test(node.value)
      ) {
        cjkLiterals.push(node.value);
      }
      if (node.type !== "CallExpression") return;
      const callee = node.callee as { type?: unknown; name?: unknown } | undefined;
      const first = (node.arguments as Array<Node> | undefined)?.[0];
      if (callee?.type !== "Identifier" || callee.name !== "$derived") return;
      if (first?.type === "MemberExpression") {
        const object = first.object as Node | undefined;
        const property = first.property as Node | undefined;
        if (typeof object?.name === "string" && typeof property?.name === "string") {
          derivedChains.add(`${object.name}.${property.name}`);
        }
        const root = object?.object as Node | undefined;
        const middle = object?.property as Node | undefined;
        if (
          typeof root?.name === "string" &&
          typeof middle?.name === "string" &&
          typeof property?.name === "string"
        ) {
          derivedChains.add(`${root.name}.${middle.name}.${property.name}`);
        }
      }
    });

    expect(derivedChains.has("messages.workbench")).toBe(true);
    expect(identifiers.has("isZh")).toBe(false);
    expect(cjkLiterals).toEqual([]);
  });

  it("flows resolveRequestLocale into the document placeholder replacement", () => {
    const hooks = ts.createSourceFile(
      "hooks.server.ts",
      source("src/hooks.server.ts"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const localeInitializers = new Map<string, string>();
    const replacements: Array<[string, string]> = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression)
      ) {
        localeInitializers.set(node.name.text, node.initializer.expression.text);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "replace"
      ) {
        const [placeholder, replacement] = node.arguments;
        if (
          placeholder &&
          replacement &&
          ts.isStringLiteral(placeholder) &&
          ts.isIdentifier(replacement)
        ) {
          replacements.push([placeholder.text, replacement.text]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(hooks);

    expect(localeInitializers.get("locale")).toBe("resolveRequestLocale");
    expect(replacements).toEqual([["%spark.locale%", "locale"]]);
  });

  it("derives the shared select placeholder directly from its localized label", () => {
    const defaults: Array<[string, string]> = [];
    walk(parse(source("src/lib/ui/Select.svelte"), { modern: true }).instance, (node) => {
      if (node.type !== "AssignmentPattern") return;
      const left = node.left as { name?: unknown } | undefined;
      const right = node.right as { name?: unknown } | undefined;
      if (typeof left?.name === "string" && typeof right?.name === "string") {
        defaults.push([left.name, right.name]);
      }
    });

    expect(defaults).toContainEqual(["placeholder", "label"]);
  });
});
