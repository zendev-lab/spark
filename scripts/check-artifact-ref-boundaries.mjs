import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const fixtures = [
  resolve(root, "packages/spark-artifacts/src/product/fixtures/invalid-evidence-ref.ts.txt"),
  resolve(
    root,
    "packages/spark-artifacts/src/product/fixtures/invalid-product-artifact-ref.ts.txt",
  ),
];
const program = ts.createProgram(fixtures, {
  allowNonTsExtensions: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
});
const fixtureSet = new Set(fixtures);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((diagnostic) => diagnostic.file && fixtureSet.has(diagnostic.file.fileName));
const messages = diagnostics.map((diagnostic) =>
  ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
);
const expected = [
  ['"artifact:not-evidence"', "EvidenceRef"],
  ['"evidence:not-product"', "ProductArtifactRef"],
];
if (
  messages.length !== expected.length ||
  expected.some((parts, index) => parts.some((part) => !messages[index]?.includes(part)))
) {
  console.error(JSON.stringify({ diagnostics: messages }, null, 2));
  process.exitCode = 1;
}

const productionFiles = ["apps", "packages"].flatMap((directory) =>
  sourceFiles(resolve(root, directory)),
);
const rules = [
  {
    id: "workflow-artifact-types",
    pattern: /\bWorkflowArtifact(?:RecordInput|RecordResult|Recorder)\b/gu,
  },
  { id: "workflow-artifact-helper", pattern: /\bartifactRecord\b/gu },
  { id: "workflow-artifact-ref", pattern: /\bartifactRef\b/gu },
  {
    id: "evidence-helper-ref-kind",
    pattern: /refKind\s*:\s*["']artifact["']\s*\|\s*["']evidence["']/gu,
  },
  { id: "product-evidence-record", pattern: /Product EvidenceRecord/gu },
  {
    id: "legacy-task-evidence-fields",
    pattern: /\b(?:inputArtifacts|outputArtifacts|artifactRefs)\b/gu,
  },
  {
    id: "legacy-review-control-fields",
    pattern:
      /\b(?:reviewArtifactRef|reviewArtifact|controlArtifactRef|controlArtifact|sparkMdArtifactRef)\b/gu,
  },
  { id: "legacy-session-review-field", pattern: /\blastReviewArtifactRef\b/gu },
];
const workflowBoundaryPaths = [
  /^packages\/spark-workflows\/src\//u,
  /^packages\/spark-runtime\/src\/workflow-role-run-adapter\.ts$/u,
  /^packages\/spark-extension\/src\/extension\/spark-workflow-run-tool-registration\.ts$/u,
];
const evidenceMigrationPaths =
  /^packages\/spark-artifacts\/src\/evidence-migration(?:-[^/]+|\.test)?\.ts$/u;
const allow = new Map([
  [
    "workflow-artifact-ref",
    [
      /^(?!packages\/spark-workflows\/src\/)(?!packages\/spark-runtime\/src\/workflow-role-run-adapter\.ts$)(?!packages\/spark-extension\/src\/extension\/spark-workflow-run-tool-registration\.ts$)/u,
    ],
  ],
  [
    "legacy-task-evidence-fields",
    [/^packages\/spark-tasks\/src\/graph-store\.ts$/u, evidenceMigrationPaths],
  ],
  ["legacy-review-control-fields", [evidenceMigrationPaths]],
  [
    "legacy-session-review-field",
    [/^packages\/spark-loop\/src\/session-goals\.ts$/u, evidenceMigrationPaths],
  ],
]);
const violations = [];
for (const file of productionFiles) {
  const path = relative(root, file).replaceAll("\\", "/");
  const text = readFileSync(file, "utf8");
  for (const rule of rules) {
    if (
      (rule.id === "workflow-artifact-ref" || rule.id === "workflow-artifact-helper") &&
      !workflowBoundaryPaths.some((pattern) => pattern.test(path))
    ) {
      continue;
    }
    if ((allow.get(rule.id) ?? []).some((pattern) => pattern.test(path))) {
      if (
        rule.id === "legacy-session-review-field" &&
        path === "packages/spark-loop/src/session-goals.ts"
      ) {
        for (const match of text.matchAll(rule.pattern)) {
          const line = text.slice(0, match.index).split("\n").length;
          const context = text.slice(
            Math.max(0, match.index - 1_500),
            match.index + match[0].length + 1_500,
          );
          if (!/function normalizeGoalReviewPointer/u.test(context)) {
            violations.push({ rule: rule.id, path, line, match: match[0] });
          }
        }
      }
      continue;
    }
    for (const match of text.matchAll(rule.pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      violations.push({ rule: rule.id, path, line, match: match[0] });
    }
  }
}
if (violations.length > 0) {
  console.error(JSON.stringify({ violations }, null, 2));
  process.exitCode = 1;
}
if (process.exitCode !== 1) {
  console.log(
    JSON.stringify(
      { diagnostics: messages, scanned: productionFiles.length, violations: 0 },
      null,
      2,
    ),
  );
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".svelte-kit", "dist", "build", "coverage"].includes(entry)) continue;
    const path = resolve(directory, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx", ".js", ".mjs", ".svelte"].includes(extname(path))) files.push(path);
  }
  return files;
}
