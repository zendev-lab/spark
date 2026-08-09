#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");
const baselinePath = join(repositoryRoot, "test", "test-quality-baseline.json");
const scanRoots = ["test", "packages", "apps"];
const ignoredDirectories = new Set([
  ".git",
  ".stryker-tmp",
  ".svelte-kit",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "reports",
]);
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const productionSourcePattern = /\.(?:[cm]?[jt]sx?|svelte)(?:["'`)]|$)/u;
const fragmentMatcherNames = new Set([
  "toContain",
  "toMatch",
  "toMatchInlineSnapshot",
  "toMatchSnapshot",
]);
const nodeAssertMatcherNames = new Set(["match", "doesNotMatch"]);
const nodeAssertBooleanMatcherNames = new Set([
  "equal",
  "notEqual",
  "notStrictEqual",
  "ok",
  "strictEqual",
]);
const fragmentCallNames = new Set(["endsWith", "includes", "startsWith", "test"]);
const promptOrInstructionNamePattern = /(?:prompt|instruction)/iu;
const nonTextPromptNamePattern = /(?:promptCacheKey|promptCount|promptSnapshots?|promptTokens?)/iu;
const nestedAgentTextNamePattern = /(?:systemPrompt|instruction|promptGuidelines|promptSnippet)/iu;
const promptPassThroughCallPattern = /(?:contentText|stringify|textContent)$/iu;
const fileReadModules = new Set(["node:fs", "fs", "node:fs/promises", "fs/promises"]);
const nodeAssertModules = new Set(["node:assert/strict", "assert/strict"]);

function scriptKind(fileName) {
  switch (extname(fileName)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isAwaitExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    (ts.isStringLiteral(node.argumentExpression) ||
      ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function expectArgument(call) {
  let expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  if (!fragmentMatcherNames.has(propertyName(expression) ?? "")) return undefined;

  let receiver = expression.expression;
  if (
    (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) &&
    propertyName(receiver) === "not"
  ) {
    receiver = receiver.expression;
  }
  if (!ts.isCallExpression(receiver) || !ts.isIdentifier(receiver.expression)) return undefined;
  if (receiver.expression.text !== "expect") return undefined;
  return receiver.arguments[0];
}

function assertArgument(call, assertBindings) {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  if (!nodeAssertMatcherNames.has(propertyName(expression) ?? "")) return undefined;
  if (!ts.isIdentifier(expression.expression) || !assertBindings.has(expression.expression.text)) {
    return undefined;
  }
  return call.arguments[0];
}

function declarationText(name, declarations, sourceFile) {
  const initializer = declarations.get(name);
  return initializer?.getText(sourceFile) ?? "";
}

function readCallFrom(initializer) {
  const expression = unwrapExpression(initializer);
  return ts.isCallExpression(expression) ? expression : undefined;
}

function collectImportedBindings(sourceFile) {
  const readBindings = new Set();
  const assertBindings = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    collectReadBindings(statement, readBindings);
    collectAssertBinding(statement, assertBindings);
  }
  return { readBindings, assertBindings };
}

function collectReadBindings(statement, readBindings) {
  if (!fileReadModules.has(statement.moduleSpecifier.text)) return;
  const namedBindings = statement.importClause?.namedBindings;
  if (!namedBindings || !ts.isNamedImports(namedBindings)) return;
  for (const element of namedBindings.elements) {
    const imported = element.propertyName?.text ?? element.name.text;
    if (imported === "readFile" || imported === "readFileSync") {
      readBindings.add(element.name.text);
    }
  }
}

function collectAssertBinding(statement, assertBindings) {
  if (!nodeAssertModules.has(statement.moduleSpecifier.text)) return;
  const binding = statement.importClause?.name?.text;
  if (binding) assertBindings.add(binding);
}

function collectDeclarations(sourceFile) {
  const declarations = new Map();
  function visitDeclaration(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visitDeclaration);
  }
  visitDeclaration(sourceFile);
  return declarations;
}

function collectUniqueDeclarations(sourceFile) {
  const candidates = new Map();
  function visitDeclaration(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const name = node.name.text;
      const existing = candidates.get(name);
      candidates.set(name, existing ? undefined : node.initializer);
    }
    ts.forEachChild(node, visitDeclaration);
  }
  visitDeclaration(sourceFile);
  return new Map([...candidates].filter((entry) => entry[1]));
}

function collectSourceVariables(declarations, readBindings, sourceFile) {
  const sourceVariables = new Set();
  for (const [name, initializer] of declarations) {
    const readCall = readCallFrom(initializer);
    if (!readCall || !ts.isIdentifier(readCall.expression)) continue;
    if (!readBindings.has(readCall.expression.text)) continue;

    const pathArgument = readCall.arguments[0];
    if (!pathArgument) continue;
    const pathText = ts.isIdentifier(pathArgument)
      ? declarationText(pathArgument.text, declarations, sourceFile)
      : pathArgument.getText(sourceFile);
    if (productionSourcePattern.test(pathText)) sourceVariables.add(name);
  }
  return sourceVariables;
}

function assertCallName(call, assertBindings) {
  const expression = call.expression;
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) {
    return undefined;
  }
  if (!ts.isIdentifier(expression.expression) || !assertBindings.has(expression.expression.text)) {
    return undefined;
  }
  return propertyName(expression);
}

function isPromptTextName(name) {
  return promptOrInstructionNamePattern.test(name) && !nonTextPromptNamePattern.test(name);
}

function isPromptLikeExpression(node, declarations, sourceFile, seen = new Set()) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    if (isPromptTextName(expression.text)) return true;
    if (seen.has(expression.text)) return false;
    const initializer = declarations.get(expression.text);
    if (!initializer) return false;
    return isPromptLikeExpression(
      initializer,
      declarations,
      sourceFile,
      new Set([...seen, expression.text]),
    );
  }
  if (ts.isElementAccessExpression(expression)) {
    return isPromptLikeExpression(expression.expression, declarations, sourceFile, seen);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const name = propertyName(expression) ?? "";
    if (isPromptTextName(name)) return true;
    if (
      (name === "content" || name === "text") &&
      ts.isCallExpression(unwrapExpression(expression.expression))
    ) {
      return isPromptLikeExpression(expression.expression, declarations, sourceFile, seen);
    }
    return false;
  }
  if (ts.isCallExpression(expression)) {
    const name = ts.isIdentifier(expression.expression)
      ? expression.expression.text
      : propertyName(expression.expression);
    if (isPromptTextName(name ?? "")) return true;
    if (
      (ts.isPropertyAccessExpression(expression.expression) ||
        ts.isElementAccessExpression(expression.expression)) &&
      isPromptLikeExpression(expression.expression.expression, declarations, sourceFile, seen)
    ) {
      return true;
    }
    if (!promptPassThroughCallPattern.test(name ?? "")) return false;
    return expression.arguments.some((argument) =>
      isPromptLikeExpression(argument, declarations, sourceFile, seen),
    );
  }
  if (ts.isBinaryExpression(expression)) {
    return (
      isPromptLikeExpression(expression.left, declarations, sourceFile, seen) ||
      isPromptLikeExpression(expression.right, declarations, sourceFile, seen)
    );
  }
  if (ts.isConditionalExpression(expression)) {
    return (
      isPromptLikeExpression(expression.whenTrue, declarations, sourceFile, seen) ||
      isPromptLikeExpression(expression.whenFalse, declarations, sourceFile, seen)
    );
  }
  return false;
}

function isPromptFragmentExpression(node, declarations, sourceFile) {
  const expression = unwrapExpression(node);
  if (!ts.isCallExpression(expression)) return false;
  const name = propertyName(expression.expression);
  if (!name || !fragmentCallNames.has(name)) return false;
  if (
    (ts.isPropertyAccessExpression(expression.expression) ||
      ts.isElementAccessExpression(expression.expression)) &&
    isPromptLikeExpression(expression.expression.expression, declarations, sourceFile)
  ) {
    return true;
  }
  return expression.arguments.some((argument) =>
    isPromptLikeExpression(argument, declarations, sourceFile),
  );
}

function findPromptFragmentExpression(node, declarations, sourceFile) {
  if (isPromptFragmentExpression(node, declarations, sourceFile)) return node;
  let found;
  ts.forEachChild(node, (child) => {
    if (!found) found = findPromptFragmentExpression(child, declarations, sourceFile);
  });
  return found;
}

function collectPromptTextFindings(sourceFile, declarations, assertBindings, fileName) {
  const findings = [];
  function add(node, subject) {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const call = ts.isExpressionStatement(node) ? node.expression : node;
    findings.push({
      file: fileName,
      line: position.line + 1,
      subject: subject.getText(sourceFile),
      assertion: ts.isCallExpression(call)
        ? call.expression.getText(sourceFile)
        : call.getText(sourceFile),
    });
  }
  function containingExpressionStatement(node) {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isExpressionStatement(current)) return current;
    }
    return undefined;
  }
  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const name =
        ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : "";
      const initializer = unwrapExpression(node.initializer);
      if (
        nestedAgentTextNamePattern.test(name) &&
        ts.isCallExpression(initializer) &&
        (ts.isPropertyAccessExpression(initializer.expression) ||
          ts.isElementAccessExpression(initializer.expression)) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === "expect" &&
        ["stringContaining", "stringMatching"].includes(propertyName(initializer.expression) ?? "")
      ) {
        const statement = containingExpressionStatement(node);
        if (statement && ts.isCallExpression(statement.expression)) add(statement, initializer);
      }
    }
    if (ts.isCallExpression(node)) {
      const expected = expectArgument(node);
      if (expected && isPromptLikeExpression(expected, declarations, sourceFile)) {
        add(node, expected);
      } else {
        const matched = assertArgument(node, assertBindings);
        if (matched && isPromptLikeExpression(matched, declarations, sourceFile)) {
          add(node, matched);
        } else {
          const name = assertCallName(node, assertBindings);
          if (name && nodeAssertBooleanMatcherNames.has(name)) {
            let subject;
            for (const argument of node.arguments) {
              subject = findPromptFragmentExpression(argument, declarations, sourceFile);
              if (subject) break;
            }
            if (subject) add(node, subject);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function collectFindings(sourceFile, sourceVariables, assertBindings, fileName) {
  const findings = [];
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const argument = expectArgument(node) ?? assertArgument(node, assertBindings);
      if (argument && ts.isIdentifier(unwrapExpression(argument))) {
        const name = unwrapExpression(argument).text;
        if (sourceVariables.has(name)) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({
            file: fileName,
            line: position.line + 1,
            sourceVariable: name,
            assertion: node.expression.getText(sourceFile),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function parseTestSource(sourceText, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const bindings = collectImportedBindings(sourceFile);
  const declarations = collectDeclarations(sourceFile);
  const promptDeclarations = collectUniqueDeclarations(sourceFile);
  return { sourceFile, declarations, promptDeclarations, ...bindings };
}

export function findSourceMirrorAssertions(sourceText, fileName = "fixture.test.ts") {
  const { sourceFile, declarations, readBindings, assertBindings } = parseTestSource(
    sourceText,
    fileName,
  );
  const sourceVariables = collectSourceVariables(declarations, readBindings, sourceFile);
  return collectFindings(sourceFile, sourceVariables, assertBindings, fileName);
}

export function findBrittlePromptTextAssertions(sourceText, fileName = "fixture.test.ts") {
  const { sourceFile, promptDeclarations, assertBindings } = parseTestSource(sourceText, fileName);
  return collectPromptTextFindings(sourceFile, promptDeclarations, assertBindings, fileName);
}

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTestFiles(path)));
    else if (entry.isFile() && testFilePattern.test(entry.name)) files.push(path);
  }
  return files;
}

function normalizedRelativePath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

async function scanRepository() {
  const paths = (
    await Promise.all(scanRoots.map((root) => collectTestFiles(join(repositoryRoot, root))))
  )
    .flat()
    .sort((left, right) => left.localeCompare(right));
  const sourceMirrorFindingsByFile = {};
  const promptTextFindingsByFile = {};
  for (const path of paths) {
    const file = normalizedRelativePath(path);
    const sourceText = await readFile(path, "utf8");
    const sourceMirrorFindings = findSourceMirrorAssertions(sourceText, file);
    if (sourceMirrorFindings.length > 0) sourceMirrorFindingsByFile[file] = sourceMirrorFindings;
    const promptTextFindings = findBrittlePromptTextAssertions(sourceText, file);
    if (promptTextFindings.length > 0) promptTextFindingsByFile[file] = promptTextFindings;
  }
  return { sourceMirrorFindingsByFile, promptTextFindingsByFile };
}

function countsFor(findingsByFile) {
  return Object.fromEntries(
    Object.entries(findingsByFile)
      .map(([file, findings]) => [file, findings.length])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function readBaseline() {
  try {
    return JSON.parse(await readFile(baselinePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read test-quality baseline at ${baselinePath}`, { cause: error });
  }
}

async function updateBaseline(counts) {
  const baseline = {
    $schema: "./test-quality-baseline.schema.json",
    sourceMirrorAssertions: counts,
  };
  await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

async function main() {
  const { sourceMirrorFindingsByFile, promptTextFindingsByFile } = await scanRepository();
  const actual = countsFor(sourceMirrorFindingsByFile);
  const promptTextCount = Object.values(promptTextFindingsByFile).reduce(
    (sum, findings) => sum + findings.length,
    0,
  );
  if (promptTextCount > 0) {
    for (const findings of Object.values(promptTextFindingsByFile)) {
      for (const finding of findings) {
        console.error(
          `${finding.file}:${finding.line} ${finding.assertion} text-matches prompt/instruction value ${finding.subject}.`,
        );
      }
    }
    console.error(
      "Remove prompt/instruction text-fragment tests. Verify structured behavior or state at the consuming boundary; do not replace them with snapshots or equivalent string coupling.",
    );
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes("--update")) {
    await updateBaseline(actual);
    console.log(
      `Updated test-quality baseline: ${Object.keys(actual).length} files, ${Object.values(actual).reduce((sum, count) => sum + count, 0)} source-mirror assertions.`,
    );
    return;
  }

  const baseline = await readBaseline();
  const expected = baseline.sourceMirrorAssertions ?? {};
  const files = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(
    (left, right) => left.localeCompare(right),
  );
  const drift = files.filter((file) => expected[file] !== actual[file]);
  if (drift.length === 0) {
    console.log(
      `Test-quality ratchet passed: ${Object.keys(actual).length} legacy files, ${Object.values(actual).reduce((sum, count) => sum + count, 0)} source-mirror assertions; 0 brittle prompt/instruction assertions.`,
    );
    return;
  }

  for (const file of drift) {
    const before = expected[file] ?? 0;
    const after = actual[file] ?? 0;
    console.error(`${file}: source-mirror assertions changed ${before} -> ${after}.`);
    if (after > before) {
      for (const finding of sourceMirrorFindingsByFile[file]?.slice(before) ?? []) {
        console.error(
          `  ${finding.file}:${finding.line} ${finding.assertion} asserts fragments of production source via ${finding.sourceVariable}.`,
        );
      }
    }
  }
  console.error(
    "Replace production-source fragment assertions with observable behavior, a schema/AST boundary, or an explicitly reviewed full golden. If reviewed debt was removed, run `pnpm run check:test-quality:update` and commit the lower baseline.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
