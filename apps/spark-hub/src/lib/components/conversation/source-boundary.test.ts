import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, parse } from "svelte/compiler";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const conversationRoot = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(conversationRoot, "../../../..");

const integrationPaths = [
  "src/lib/SessionsWorkspace.svelte",
  "src/lib/sessions-workspace/SessionStartPane.svelte",
  "src/lib/sessions-workspace/SessionConversationPane.svelte",
  "src/lib/sessions-workspace/SessionStageHeader.svelte",
  "src/lib/sessions-workspace/SessionComposerPane.svelte",
] as const;

type SvelteNode = {
  type?: string;
  name?: string;
  attributes?: SvelteNode[];
  expression?: SvelteNode;
  value?: unknown;
  fragment?: SvelteNode;
  nodes?: SvelteNode[];
  [key: string]: unknown;
};

describe("source-derived conversation component boundary", () => {
  it("pins upstream provenance and retains the complete MIT license golden", () => {
    const vendor = readFileSync(join(conversationRoot, "VENDOR.md"), "utf8");
    const license = readFileSync(join(conversationRoot, "UPSTREAM-LICENSE.txt"), "utf8");

    expect(vendor).toBe(readFileSync(join(conversationRoot, "VENDOR.md.golden"), "utf8"));
    expect(license).toBe(
      `MIT License\n\nCopyright (c) 2026 Sikandar Bhide\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`,
    );
  });

  it("keeps provider and AI chat runtimes outside the source-derived shell", () => {
    const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencyNames = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);
    const imports = new Set(
      sourceFiles(conversationRoot).flatMap((path) =>
        moduleSpecifiers(readFileSync(path, "utf8"), path),
      ),
    );

    expect(imports.has("ai")).toBe(false);
    expect(imports.has("@ai-sdk/svelte")).toBe(false);
    expect(imports.has("shiki")).toBe(false);
    expect(imports.has("tailwindcss")).toBe(false);
    expect(dependencyNames.has("ai")).toBe(false);
    expect(dependencyNames.has("@ai-sdk/svelte")).toBe(false);
    expect(dependencyNames.has("@shikijs/themes")).toBe(false);
    expect(dependencyNames.has("tailwindcss")).toBe(false);
    expect(dependencyNames.has("svelte-streamdown")).toBe(false);
    expect(dependencyNames.has("@lucide/svelte")).toBe(false);
    expect(dependencyNames.has("bits-ui")).toBe(false);
    expect(dependencyNames.has("@zendev-lab/spark-ui")).toBe(true);
  });

  it("keeps the presentation shell wired to daemon-backed forms", () => {
    const contracts = new Map(
      integrationPaths.map((relativePath) => {
        const source = readFileSync(join(appRoot, relativePath), "utf8");
        compile(source, { filename: relativePath, generate: false });
        return [
          relativePath,
          componentContract(
            parse(source, { filename: relativePath, modern: true }) as unknown as SvelteNode,
          ),
        ];
      }),
    );

    expect(contracts.get(integrationPaths[0])?.components.has("SessionStartPane")).toBe(true);
    expect(contracts.get(integrationPaths[2])?.components.has("ConversationViewport")).toBe(true);
    expect(contracts.get(integrationPaths[2])?.components.has("ConversationMessage")).toBe(true);
    expect(contracts.get(integrationPaths[2])?.components.has("SessionComposerPane")).toBe(true);
    expect(contracts.get(integrationPaths[2])?.formActions).toEqual(
      new Set(["?/selectModel", "?/selectThinking", "?/cancelTurn", "?/sendMessage"]),
    );
    expect(contracts.get(integrationPaths[2])?.enhanceExpressions).toEqual(
      new Set([
        "host.enhanceSelectModel",
        "host.enhanceSelectThinking",
        "host.enhanceRemoveQueuedTurn",
        "host.enhanceRetryMessage",
      ]),
    );
    expect(contracts.get(integrationPaths[2])?.inputNames.has("submissionId")).toBe(true);
    expect(
      contracts
        .get(integrationPaths[2])
        ?.componentAttributes.get("ConversationMessage")
        ?.some((name) => name === "retryAction"),
    ).toBe(true);
    expect(contracts.get(integrationPaths[3])?.formActions.has("?/cancelTurn")).toBe(true);
    expect(contracts.get(integrationPaths[4])?.components.has("Composer")).toBe(true);
    expect(contracts.get(integrationPaths[4])?.components.has("ModelRuntimeControl")).toBe(true);
    expect(contracts.get(integrationPaths[4])?.formActions.has("?/sendMessage")).toBe(true);
    expect(contracts.get(integrationPaths[4])?.enhanceExpressions.has("enhanceSendMessage")).toBe(
      true,
    );
    expect(contracts.get(integrationPaths[4])?.inputNames.has("submissionId")).toBe(true);
    expect(contracts.get(integrationPaths[1])?.formActions.has("?/startConversation")).toBe(true);
    expect(contracts.get(integrationPaths[1])?.inputNames.has("submissionId")).toBe(true);
  });
});

function componentContract(ast: SvelteNode) {
  const components = new Set<string>();
  const formActions = new Set<string>();
  const enhanceExpressions = new Set<string>();
  const inputNames = new Set<string>();
  const componentAttributes = new Map<string, string[]>();
  // eslint-disable-next-line complexity -- one AST visitor collects the complete component/form contract.
  walk(ast.fragment, (node) => {
    if (node.type === "Component" && node.name) {
      components.add(node.name);
      componentAttributes.set(
        node.name,
        (node.attributes ?? []).flatMap((attribute) =>
          attribute.type === "Attribute" && attribute.name ? [attribute.name] : [],
        ),
      );
    }
    if (node.type === "RegularElement" && node.name === "input") {
      for (const attribute of node.attributes ?? []) {
        if (attribute.type === "Attribute" && attribute.name === "name") {
          const text = textAttribute(attribute);
          if (text) inputNames.add(text);
        }
      }
    }
    if (node.type === "UseDirective" && node.name === "enhance") {
      const expression = node.expression;
      if (expression?.type === "Identifier" && expression.name)
        enhanceExpressions.add(expression.name);
      if (expression?.type === "MemberExpression") {
        const object = expression.object as SvelteNode | undefined;
        const property = expression.property as SvelteNode | undefined;
        if (object?.name && property?.name)
          enhanceExpressions.add(`${object.name}.${property.name}`);
      }
    }
    if (node.type !== "RegularElement" || node.name !== "form") return;
    for (const attribute of node.attributes ?? []) {
      if (attribute.type !== "Attribute" || attribute.name !== "action") continue;
      const text = textAttribute(attribute);
      if (text) formActions.add(text);
    }
  });
  return { components, formActions, enhanceExpressions, inputNames, componentAttributes };
}

function textAttribute(node: SvelteNode): string | undefined {
  const value = node.value;
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const text = (value[0] as { data?: unknown }).data;
  return typeof text === "string" ? text : undefined;
}

function moduleSpecifiers(source: string, path: string): string[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return file.statements.flatMap((statement) =>
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

function walk(value: unknown, visit: (node: SvelteNode) => void): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const node = value as SvelteNode;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent" || key === "metadata") continue;
    walk(child, visit);
  }
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || ![".svelte", ".ts"].includes(extname(entry.name))) return [];
    return entry.name.endsWith(".test.ts") ? [] : [path];
  });
}
