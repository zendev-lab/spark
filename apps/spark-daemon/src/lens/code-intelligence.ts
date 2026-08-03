import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";

import { kind, Lang, parse } from "@ast-grep/napi";
import { walkTree } from "@zendev-lab/spark-files";
import type {
  CodeGraphEdge,
  CodeSymbol,
  StructuralMatch,
  WorkspaceRevision,
} from "@zendev-lab/spark-lens";

import { DaemonLensCodeIntelligenceStore } from "./code-intelligence-store.ts";

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".rs"]);

export class DaemonLensCodeIntelligence {
  readonly #store: DaemonLensCodeIntelligenceStore;

  constructor(store: DaemonLensCodeIntelligenceStore) {
    this.#store = store;
  }

  async index(input: {
    revision: WorkspaceRevision;
    changedPaths?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ indexedPaths: string[]; symbols: number; edges: number }> {
    const root = input.revision.workspaceRoot;
    const previous = this.#store.currentRevision(root);
    const allPaths = await sourcePaths(root, input.signal);
    const storedDigests = this.#store.fileDigests(root);
    const sourceByPath = new Map<string, string>();
    const digestByPath = new Map<string, string>();
    for (const path of allPaths) {
      input.signal?.throwIfAborted();
      const source = await readFile(resolve(root, path), "utf8");
      sourceByPath.set(path, source);
      digestByPath.set(path, createHash("sha256").update(source).digest("hex"));
    }
    const detectedChanges = [
      ...allPaths.filter((path) => storedDigests.get(path) !== digestByPath.get(path)),
      ...[...storedDigests.keys()].filter((path) => !digestByPath.has(path)),
    ];
    const requested =
      previous === undefined
        ? allPaths
        : (input.changedPaths ?? detectedChanges).filter((path) =>
            SUPPORTED_EXTENSIONS.has(extname(path)),
          );
    const closure =
      previous === undefined
        ? requested
        : this.#store.reverseDependencyPaths(root, previous, requested);
    const affectedPaths = [...new Set(closure)].sort();
    const indexedPaths = affectedPaths.filter((path) => allPaths.includes(path));
    const symbols: CodeSymbol[] = [];
    const edges: CodeGraphEdge[] = [];
    const available = new Set(allPaths);
    for (const path of indexedPaths) {
      input.signal?.throwIfAborted();
      const source = sourceByPath.get(path)!;
      const extracted = extractFileIntelligence({
        workspaceRoot: root,
        revisionDigest: input.revision.digest,
        path,
        source,
        availablePaths: available,
      });
      symbols.push(...extracted.symbols);
      edges.push(...extracted.edges);
    }
    this.#store.replacePaths({
      workspaceRoot: root,
      revisionDigest: input.revision.digest,
      paths: affectedPaths,
      fileDigests: digestByPath,
      symbols,
      edges,
    });
    return { indexedPaths, symbols: symbols.length, edges: edges.length };
  }

  search(revision: WorkspaceRevision, query: string, limit = 20): CodeSymbol[] {
    this.#assertCurrent(revision);
    return this.#store.searchSymbols(revision.workspaceRoot, revision.digest, query, limit);
  }

  outline(revision: WorkspaceRevision, path: string): CodeSymbol[] {
    this.#assertCurrent(revision);
    return this.#store.outline(revision.workspaceRoot, revision.digest, path);
  }

  impact(revision: WorkspaceRevision, path: string): CodeGraphEdge[] {
    this.#assertCurrent(revision);
    return this.#store.impact(revision.workspaceRoot, revision.digest, path);
  }

  async structuralSearch(input: {
    revision: WorkspaceRevision;
    pattern: string;
    path?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<StructuralMatch[]> {
    this.#assertCurrent(input.revision);
    const paths = input.path
      ? [input.path]
      : await sourcePaths(input.revision.workspaceRoot, input.signal);
    const matches: StructuralMatch[] = [];
    for (const path of paths) {
      input.signal?.throwIfAborted();
      const language = astLanguage(path);
      if (!language) continue;
      const source = await readFile(resolve(input.revision.workspaceRoot, path), "utf8");
      for (const node of parse(language, source).root().findAll(input.pattern)) {
        const range = node.range();
        matches.push({
          path,
          startLine: range.start.line,
          endLine: range.end.line,
          kind: String(node.kind()),
          source: "@ast-grep/napi",
          read: {
            path,
            offset: range.start.line + 1,
            limit: Math.max(1, range.end.line - range.start.line + 1),
          },
        });
        if (matches.length >= (input.limit ?? 100)) return matches;
      }
    }
    return matches;
  }

  #assertCurrent(revision: WorkspaceRevision): void {
    if (this.#store.currentRevision(revision.workspaceRoot) !== revision.digest) {
      throw new Error(`Lens code graph is stale for revision ${revision.digest}`);
    }
  }
}

function extractFileIntelligence(input: {
  workspaceRoot: string;
  revisionDigest: string;
  path: string;
  source: string;
  availablePaths: ReadonlySet<string>;
}): { symbols: CodeSymbol[]; edges: CodeGraphEdge[] } {
  const language = astLanguage(input.path);
  const symbols = language ? extractAstSymbols(input, language) : extractFallbackSymbols(input);
  const edges = extractImportEdges(input);
  return { symbols, edges };
}

function extractAstSymbols(
  input: {
    workspaceRoot: string;
    revisionDigest: string;
    path: string;
    source: string;
  },
  language: Lang,
): CodeSymbol[] {
  const root = parse(language, input.source).root();
  const kinds = [
    ["function_declaration", "function"],
    ["class_declaration", "class"],
    ["interface_declaration", "interface"],
    ["type_alias_declaration", "type"],
    ["method_definition", "method"],
    ["lexical_declaration", "variable"],
  ] as const;
  const symbols: CodeSymbol[] = [];
  for (const [nodeKind, symbolKind] of kinds) {
    for (const node of root.findAll(kind(language, nodeKind as never))) {
      const name = node.field("name")?.text() ?? declarationName(node.text());
      if (!name) continue;
      const range = node.range();
      symbols.push(
        codeSymbol(input, {
          name,
          kind: symbolKind,
          startLine: range.start.line,
          endLine: range.end.line,
          source: "@ast-grep/napi",
          confidence: symbolKind === "variable" ? 0.75 : 0.95,
        }),
      );
    }
  }
  return symbols;
}

function extractFallbackSymbols(input: {
  workspaceRoot: string;
  revisionDigest: string;
  path: string;
  source: string;
}): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const pattern =
    extname(input.path) === ".py"
      ? /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/gmu
      : /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gmu;
  for (const match of input.source.matchAll(pattern)) {
    const prefix = input.source.slice(0, match.index);
    const line = prefix.split("\n").length - 1;
    const token = extname(input.path) === ".py" ? match[2]! : match[1]!;
    const name = extname(input.path) === ".py" ? match[3]! : match[2]!;
    symbols.push(
      codeSymbol(input, {
        name,
        kind:
          token === "class" || token === "struct" || token === "enum"
            ? "class"
            : token === "trait"
              ? "interface"
              : token === "type"
                ? "type"
                : "function",
        startLine: line,
        endLine: line,
        source: "syntax-fallback",
        confidence: 0.6,
      }),
    );
  }
  return symbols;
}

function extractImportEdges(input: {
  workspaceRoot: string;
  revisionDigest: string;
  path: string;
  source: string;
  availablePaths: ReadonlySet<string>;
}): CodeGraphEdge[] {
  if (![".ts", ".tsx", ".js", ".jsx"].includes(extname(input.path))) return [];
  const edges: CodeGraphEdge[] = [];
  const pattern = /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu;
  for (const match of input.source.matchAll(pattern)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) continue;
    const target = resolveImportPath(input.path, specifier, input.availablePaths);
    edges.push({
      id: digest(["import", input.path, target ?? specifier]),
      workspaceRoot: input.workspaceRoot,
      revisionDigest: input.revisionDigest,
      fromPath: input.path,
      ...(target ? { toPath: target } : {}),
      toSymbol: specifier,
      kind: "imports",
      source: "@ast-grep/napi+module-resolution",
      confidence: target ? 0.95 : 0.5,
    });
  }
  return edges;
}

function resolveImportPath(
  fromPath: string,
  specifier: string,
  availablePaths: ReadonlySet<string>,
): string | undefined {
  const base = normalize(join(dirname(fromPath), specifier)).replaceAll("\\", "/");
  for (const candidate of [
    base,
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => `${base}/index${extension}`),
  ]) {
    if (availablePaths.has(candidate)) return candidate;
  }
  return undefined;
}

function codeSymbol(
  input: {
    workspaceRoot: string;
    revisionDigest: string;
    path: string;
  },
  symbol: Omit<CodeSymbol, "id" | "workspaceRoot" | "revisionDigest" | "path" | "read">,
): CodeSymbol {
  return {
    id: digest([input.path, symbol.kind, symbol.name, symbol.startLine]),
    workspaceRoot: input.workspaceRoot,
    revisionDigest: input.revisionDigest,
    path: input.path,
    ...symbol,
    read: {
      path: input.path,
      offset: symbol.startLine + 1,
      limit: Math.max(1, symbol.endLine - symbol.startLine + 1),
    },
  };
}

function astLanguage(path: string): Lang | undefined {
  switch (extname(path)) {
    case ".ts":
      return Lang.TypeScript;
    case ".tsx":
    case ".jsx":
      return Lang.Tsx;
    case ".js":
      return Lang.JavaScript;
    default:
      return undefined;
  }
}

function declarationName(text: string): string | undefined {
  return /(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/u.exec(text)?.[1];
}

async function sourcePaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of walkTree(root, { signal })) {
    if (!SUPPORTED_EXTENSIONS.has(extname(entry.relativePath))) continue;
    paths.push(entry.relativePath.replaceAll("\\", "/"));
  }
  return paths.sort((left, right) => left.localeCompare(right));
}

function digest(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
