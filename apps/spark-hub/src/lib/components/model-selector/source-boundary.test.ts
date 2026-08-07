import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, parse } from "svelte/compiler";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

function file(name: string) {
  return readFileSync(join(root, name), "utf8");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
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

describe("source-derived model selector boundary", () => {
  it("pins the complete upstream provenance and license documents", () => {
    expect(sha256(file("VENDOR.md"))).toBe(
      "6831ecabe67d835dc1f64cd6f02a44f06de1d73f60929e3594f16266f6fca66d",
    );
    expect(sha256(file("UPSTREAM-LICENSE.txt"))).toBe(
      "4c77bfa732c9331e487ffb1fd25ec4483da6bf0200c0bb9bb2f62ab644d1f24f",
    );
  });

  it("uses the local presentation primitive without AI runtime imports", () => {
    const imports: string[] = [];
    walk(parse(file("ModelPicker.svelte"), { modern: true }).instance, (node) => {
      if (node.type !== "ImportDeclaration") return;
      const source = node.source as { value?: unknown } | undefined;
      if (typeof source?.value === "string") imports.push(source.value);
    });

    expect(imports).toEqual(["@zendev-lab/spark-ui", "@zendev-lab/spark-ui/headless", "./types"]);
  });

  it("compiles unified model and reasoning controls with structured ownership", () => {
    const picker = file("ModelPicker.svelte");
    const runtime = file("ModelRuntimeControl.svelte");
    expect(() =>
      compile(picker, { filename: "ModelPicker.svelte", generate: "server" }),
    ).not.toThrow();
    expect(() =>
      compile(runtime, { filename: "ModelRuntimeControl.svelte", generate: "server" }),
    ).not.toThrow();

    const pickerCalls = new Set<string>();
    walk(parse(picker, { modern: true }).instance, (node) => {
      if (node.type !== "CallExpression") return;
      const callee = node.callee as { name?: unknown } | undefined;
      if (typeof callee?.name === "string") pickerCalls.add(callee.name);
    });
    const runtimeAst = parse(runtime, { modern: true });
    const runtimeClasses = new Set<string>();
    const bindings = new Set<string>();
    const ifTests = new Set<string>();
    const imports = new Set<string>();
    walk(runtimeAst, (node) => {
      if (node.type === "ImportDeclaration") {
        const source = node.source as { value?: unknown } | undefined;
        if (typeof source?.value === "string") imports.add(source.value);
      }
      if (node.type === "Attribute" && node.name === "class") {
        const value = node.value as Array<{ data?: unknown }> | undefined;
        for (const part of value ?? [])
          if (typeof part.data === "string") runtimeClasses.add(part.data);
      }
      if (node.type === "BindDirective" && typeof node.name === "string") bindings.add(node.name);
      if (node.type === "IfBlock") {
        const test = node.test as { name?: unknown } | undefined;
        if (typeof test?.name === "string") ifTests.add(test.name);
      }
    });

    expect(pickerCalls.has("$bindable")).toBe(true);
    expect(runtimeClasses.has("thinking-control")).toBe(true);
    expect(bindings.has("open")).toBe(true);
    expect(bindings.has("value")).toBe(true);
    expect(ifTests.has("reasoningSupported")).toBe(true);
    expect(imports.has("@zendev-lab/spark-session")).toBe(false);
    expect(imports.has("@zendev-lab/spark-daemon")).toBe(false);
    expect(imports.has("$lib/server/db")).toBe(false);
  });
});
