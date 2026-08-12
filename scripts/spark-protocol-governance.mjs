import { createRequire } from "node:module";
import { extname } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const SPARK_PROTOCOL_ROOT_SPECIFIER = "@zendev-lab/spark-protocol";

const PRODUCTION_SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".svelte",
  ".ts",
  ".tsx",
]);

const FORBIDDEN_SUBPATH_IMPORTS = {
  domain: [
    /^\.\/presentation\.ts$/u,
    /^\.\/a2ui\.ts$/u,
    /^\.\/conversation\.ts$/u,
    /^\.\/action-bars\.ts$/u,
    /^\.\/daemon\.ts$/u,
    /^\.\/runtime\.ts$/u,
  ],
  presentation: [
    /^\.\/daemon\.ts$/u,
    /^\.\/task-claim\.ts$/u,
    /^\.\/local-rpc-orpc-contract\.ts$/u,
    /^\.\/_local-rpc-catalog\.ts$/u,
  ],
  runtime: [/.*/u],
};

export function isSparkProductionSourcePath(path) {
  if (!PRODUCTION_SOURCE_EXTENSIONS.has(extname(path))) return false;
  const normalized = path.replaceAll("\\", "/");
  if (/\.(?:test|spec)\.[^.]+$/u.test(normalized)) return false;
  if (normalized.includes("/src/paraglide/")) return false;
  if (normalized.includes("/__tests__/")) return false;
  return !normalized.includes("/test/");
}

export function findSparkProtocolRootReferences(source, path = "source.ts") {
  return moduleReferences(source, path)
    .filter((reference) => reference.specifier === SPARK_PROTOCOL_ROOT_SPECIFIER)
    .map(({ kind, index, text }) => ({ kind, index, text }));
}

export function sparkProtocolSubpathBoundaryViolations(subpath, source) {
  const imports = moduleReferences(source, `${subpath}.ts`)
    .map((reference) => reference.specifier)
    .filter((specifier) => specifier.startsWith("."));
  if (subpath === "runtime") {
    return imports
      .filter((specifier) => !specifier.startsWith("./runtime-v1/"))
      .map((specifier) => `runtime may import only ./runtime-v1/*, received ${specifier}`);
  }
  const forbidden = FORBIDDEN_SUBPATH_IMPORTS[subpath] ?? [];
  return imports.flatMap((specifier) =>
    forbidden.some((pattern) => pattern.test(specifier))
      ? [`${subpath} may not import ${specifier}`]
      : [],
  );
}

function moduleReferences(source, path) {
  if (extname(path) === ".svelte") {
    return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/giu)].flatMap((match) =>
      moduleReferences(match[1], `${path}.ts`).map((reference) => ({
        ...reference,
        index: (match.index ?? 0) + match[0].indexOf(match[1]) + reference.index,
      })),
    );
  }
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  const references = [];
  const add = (kind, literal, node) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    references.push({
      kind,
      specifier: literal.text,
      index: node.getStart(sourceFile),
      text: node.getText(sourceFile),
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      add(node.importClause ? "import" : "side-effect-import", node.moduleSpecifier, node);
    } else if (ts.isExportDeclaration(node)) {
      add("export", node.moduleSpecifier, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add("import-equals", node.moduleReference.expression, node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add("type-import", node.argument.literal, node);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add("dynamic-import", node.arguments[0], node);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        add("require", node.arguments[0], node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references.sort((left, right) => left.index - right.index);
}

function scriptKind(path) {
  switch (extname(path)) {
    case ".js":
    case ".cjs":
    case ".mjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}
