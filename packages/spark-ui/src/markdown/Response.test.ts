import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));
const path = join(root, "Response.svelte");

function responseAst() {
  return parse(readFileSync(path, "utf8"), { modern: true });
}

function walk(value: unknown, visit: (node: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string") visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "parent") walk(child, visit);
  }
}

describe("Svelte AI Elements Response boundary", () => {
  it("pins complete Response provenance and license goldens", () => {
    expect(readFileSync(join(root, "VENDOR.md"), "utf8")).toBe(
      readFileSync(join(root, "VENDOR.md.golden"), "utf8"),
    );
    expect(readFileSync(join(root, "UPSTREAM-LICENSE.txt"), "utf8")).toBe(
      readFileSync(join(root, "UPSTREAM-LICENSE.txt.golden"), "utf8"),
    );
  });

  it("loads the rich-markdown component stack on demand", () => {
    const imports: string[] = [];
    const dynamicImports: string[] = [];
    walk(responseAst().instance, (node) => {
      if (node.type === "ImportDeclaration") {
        const source = node.source as { value?: unknown } | undefined;
        if (typeof source?.value === "string") imports.push(source.value);
        return;
      }
      const isDynamicImport =
        node.type === "ImportExpression" ||
        (node.type === "CallExpression" &&
          (node.callee as { type?: unknown } | undefined)?.type === "Import");
      if (!isDynamicImport) return;
      const source = node.source as { value?: unknown } | undefined;
      if (typeof source?.value === "string") dynamicImports.push(source.value);
    });

    // Heavy grammars (shiki, KaTeX, mermaid) stay out of the initial bundle.
    expect(imports).toEqual(["svelte", "svelte-streamdown"]);
    expect(dynamicImports).toEqual([
      "svelte-streamdown/code",
      "svelte-streamdown/math",
      "svelte-streamdown/mermaid",
    ]);
  });

  it("retains structured selectors for code, tables, mermaid, and streaming", () => {
    const attributes = new Set<string>();
    walk(responseAst().css, (node) => {
      if (node.type !== "AttributeSelector") return;
      const name = node.name as { name?: unknown } | string | undefined;
      if (typeof name === "string") attributes.add(name);
      else if (typeof name?.name === "string") attributes.add(name.name);
    });

    expect(attributes).toEqual(
      new Set([
        "type",
        "data-streamdown-code",
        "data-streamdown-table-download",
        "data-streamdown-mermaid",
        "data-streamdown-table",
        "data-streaming",
      ]),
    );
  });

  it("retains a structured reduced-motion media contract", () => {
    const media: Array<{ prelude: unknown; declarations: Array<[unknown, unknown]> }> = [];
    walk(responseAst().css, (node) => {
      if (node.type !== "Atrule" || node.name !== "media") return;
      const declarations: Array<[unknown, unknown]> = [];
      walk(node.block, (child) => {
        if (child.type === "Declaration") declarations.push([child.property, child.value]);
      });
      media.push({ prelude: node.prelude, declarations });
    });

    expect(media).toEqual([
      {
        prelude: "(prefers-reduced-motion: reduce)",
        declarations: [
          ["animation-duration", "0.01ms !important"],
          ["transition-duration", "0.01ms !important"],
          ["animation", "none"],
          ["content", "none"],
        ],
      },
    ]);
  });
});
