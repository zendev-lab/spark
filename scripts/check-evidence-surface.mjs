import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const controlledFixtureRoots = [
  resolve(root, "test/fixtures/evidence-surface"),
  resolve(root, "test/fixtures/legacy-evidence"),
];
const typeFixtureExpectations = new Map([
  ["invalid-evidence-ref.ts.txt", ['"artifact:not-evidence"', "EvidenceRef"]],
  ["invalid-artifact-ref.ts.txt", ['"evidence:not-artifact"', "ArtifactRef"]],
  ["invalid-evidence-kind.ts.txt", ['"issue"', "EvidenceKind"]],
  ["invalid-artifact-kind.ts.txt", ['"record"', "ArtifactKind"]],
]);
const typeFixtures = [...typeFixtureExpectations.keys()].map((name) =>
  resolve(root, "test/fixtures/evidence-surface", name),
);
const program = ts.createProgram(typeFixtures, {
  allowNonTsExtensions: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
});
const typeFixtureSet = new Set(typeFixtures);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((diagnostic) => diagnostic.file && typeFixtureSet.has(diagnostic.file.fileName));
const diagnosticsByFixture = new Map();
for (const diagnostic of diagnostics) {
  const fileName = basename(diagnostic.file.fileName);
  const messages = diagnosticsByFixture.get(fileName) ?? [];
  messages.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  diagnosticsByFixture.set(fileName, messages);
}
const fixtureViolations = [];
for (const [fileName, expectedParts] of typeFixtureExpectations) {
  const messages = diagnosticsByFixture.get(fileName) ?? [];
  if (messages.length !== 1 || expectedParts.some((part) => !messages[0]?.includes(part))) {
    fixtureViolations.push({
      rule: "negative-type-fixture",
      path: `test/fixtures/evidence-surface/${fileName}`,
      expectedParts,
      diagnostics: messages,
    });
  }
}
for (const fileName of diagnosticsByFixture.keys()) {
  if (!typeFixtureExpectations.has(fileName)) {
    fixtureViolations.push({
      rule: "unexpected-negative-type-fixture",
      path: `test/fixtures/evidence-surface/${fileName}`,
      diagnostics: diagnosticsByFixture.get(fileName),
    });
  }
}

const evidenceSurfaceFixture = readJsonFixture(
  "test/fixtures/evidence-surface/negative-values.json",
);
if (
  evidenceSurfaceFixture.wrongNamespaceRef !== "artifact:not-evidence" ||
  evidenceSurfaceFixture.wrongArtifactNamespaceRef !== "evidence:not-artifact" ||
  evidenceSurfaceFixture.wrongKind !== "issue" ||
  evidenceSurfaceFixture.wrongArtifactKind !== "record" ||
  evidenceSurfaceFixture.oldField?.artifactRef !== "evidence:legacy-field"
) {
  fixtureViolations.push({
    rule: "negative-runtime-fixture",
    path: "test/fixtures/evidence-surface/negative-values.json",
    message:
      "fixture must cover both wrong namespaces, both wrong kind lanes, and a retired Evidence field",
  });
}
for (const fixtureDirectory of [
  "test/fixtures/evidence-surface",
  "test/fixtures/legacy-evidence",
]) {
  const manifest = readJsonFixture(`${fixtureDirectory}/manifest.json`);
  const registered = new Set(Object.keys(manifest.fixtures ?? {}));
  const actual = readdirSync(resolve(root, fixtureDirectory)).filter(
    (name) => name !== "manifest.json",
  );
  for (const name of actual) {
    if (!registered.has(name)) {
      fixtureViolations.push({
        rule: "unregistered-controlled-fixture",
        path: `${fixtureDirectory}/${name}`,
      });
    }
  }
}

const scannedFiles = ["apps", "packages", "test"]
  .flatMap((directory) => sourceFiles(resolve(root, directory)))
  .filter((file) => !controlledFixtureRoots.some((fixtureRoot) => isInside(fixtureRoot, file)));
const evidenceMigrationPaths =
  /^packages\/spark-artifacts\/src\/evidence-migration(?:-[^/]+|\.test)?\.ts$/u;
const workflowBoundaryPaths = [
  /^packages\/spark-workflows\/src\//u,
  /^packages\/spark-runtime\/src\/workflow-role-run-adapter\.ts$/u,
  /^packages\/spark-extension\/src\/extension\/spark-workflow-run-tool-registration\.ts$/u,
];
const evidenceOwnedArtifactRefPaths = [
  /^packages\/spark-ask\/src\//u,
  /^packages\/spark-runtime\/src\//u,
  /^packages\/spark-workflows\/src\//u,
  /^packages\/spark-loop\/src\//u,
  /^packages\/spark-tasks\/src\//u,
  /^packages\/spark-memory\/src\//u,
  /^packages\/spark-extension\/src\//u,
  /^packages\/spark-artifacts\/src\/extension\.ts$/u,
  /^test\/(?:evidence-ask|spark-ask-tool|spark-session-repro|spark-tools|spark-workflows|tasks-store)\.test\.ts$/u,
];
const rules = [
  {
    id: "retired-internal-artifact-symbol",
    pattern:
      /\b(?:artifactStore|ArtifactStore|RoleRunArtifact\w*|AskArtifact\w*|SparkAsk\w*Artifact\w*|EvidenceArtifact\w*|registerSparkArtifactTool|normalizeArtifact(?:Boolean|Limit)|generatedEvidenceArtifact|evidenceArtifacts)\b/gu,
    appliesTo: (path) => evidenceOwnedArtifactRefPaths.some((candidate) => candidate.test(path)),
  },
  {
    id: "retired-role-run-artifact-alias",
    pattern: /(?:role_run_artifact_compact|compact-role-run-artifacts|role-run[- ]artifacts?)/giu,
  },
  {
    id: "mixed-evidence-artifact-wording",
    pattern: /\b(?:Evidence|ask|validation|learning|role-run) artifacts?\b/giu,
  },
  {
    id: "mixed-evidence-ref-prefix-alias",
    pattern: /\(\?:artifact\|evidence\)|\(artifact\|evidence\)|artifact:\s+or\s+evidence:/gu,
  },
  {
    id: "legacy-task-evidence-fields",
    pattern: /\b(?:inputArtifacts|outputArtifacts)\b/gu,
  },
  {
    id: "legacy-review-control-fields",
    pattern:
      /\b(?:reviewArtifactRef|reviewArtifact|controlArtifactRef|controlArtifact|sparkMdArtifactRef|lastReviewArtifactRef|askArtifactRef|askArtifactRefs)\b/gu,
  },
  {
    id: "cross-lane-ref-literal",
    pattern:
      /(?:\bevidenceRef\s*:\s*["']artifact:|["']evidenceRef["']\s*:\s*["']artifact:|\bartifactRef\s*:\s*["']evidence:|["']artifactRef["']\s*:\s*["']evidence:)/gu,
  },
  {
    id: "workflow-artifact-types",
    pattern: /\bWorkflowArtifact(?:RecordInput|RecordResult|Recorder)\b/gu,
    appliesTo: (path) => workflowBoundaryPaths.some((candidate) => candidate.test(path)),
  },
  {
    id: "workflow-artifact-helper",
    pattern: /\bartifactRecord\b/gu,
    appliesTo: (path) => workflowBoundaryPaths.some((candidate) => candidate.test(path)),
  },
  {
    id: "artifact-ref-on-evidence-surface",
    pattern: /\bartifactRefs?\b/gu,
    appliesTo: (path) => evidenceOwnedArtifactRefPaths.some((candidate) => candidate.test(path)),
  },
  {
    id: "evidence-helper-ref-kind-alias",
    pattern: /refKind\s*:\s*["']artifact["']\s*\|\s*["']evidence["']/gu,
  },
  {
    id: "retired-product-artifact-surface",
    pattern: /\b(?:ProductArtifact\w*|productArtifact\w*|Product Artifacts?)\b/gu,
  },
  {
    id: "retired-product-artifact-wire",
    pattern: /product[-_]artifact/giu,
  },
  { id: "artifact-evidence-record", pattern: /Artifact EvidenceRecord/gu },
];
const allow = new Map([
  [
    "legacy-task-evidence-fields",
    [/^packages\/spark-tasks\/src\/graph-store\.ts$/u, evidenceMigrationPaths],
  ],
  [
    "legacy-review-control-fields",
    [/^packages\/spark-loop\/src\/session-goals\.ts$/u, evidenceMigrationPaths],
  ],
  ["cross-lane-ref-literal", [evidenceMigrationPaths]],
  ["mixed-evidence-ref-prefix-alias", [evidenceMigrationPaths]],
  [
    "artifact-ref-on-evidence-surface",
    [
      /^packages\/spark-artifacts\/src\/extension\.ts$/u,
      /^packages\/spark-tasks\/src\/(?:common|extension|graph|internal)\.ts$/u,
      /^packages\/spark-tasks\/src\/graph-store\.ts$/u,
      /^packages\/spark-extension\/src\/extension\/spark-task-artifact\.ts$/u,
      /^packages\/spark-extension\/src\/extension\/(?:spark-fleet-target|spark-plan-tasks-tool-registration|spark-task-session-dispatch|task-plan-tool)(?:\.test)?\.ts$/u,
      /^packages\/spark-extension\/src\/__tests__\/spark-fleet-target\.test\.ts$/u,
      /^packages\/spark-extension\/src\/extension\/spark-finish-review-workflow(?:\.test)?\.ts$/u,
      /^packages\/spark-extension\/src\/extension\/spark-repro-report(?:\.test)?\.ts$/u,
      /^packages\/spark-extension\/src\/extension\/spark-lens-(?:completion-gate|tool)\.ts$/u,
      /^packages\/spark-extension\/src\/extension\/subject-review-store\.ts$/u,
      /^packages\/spark-extension\/src\/__tests__\/(?:spark-role-run-(?:observability|terminal-visibility|tui)|tasks-store)\.test\.ts$/u,
      /^packages\/spark-loop\/src\/session-goals\.ts$/u,
      /^packages\/spark-tasks\/src\/execution-policy\.test\.ts$/u,
      evidenceMigrationPaths,
    ],
  ],
]);

const negativeProbe = process.argv[2];
if (negativeProbe) {
  const result = runNegativeProbe(negativeProbe);
  console.error(JSON.stringify(result, null, 2));
  if (!result.supported) process.exitCode = 2;
  else if (result.rejected) process.exitCode = 1;
} else {
  const violations = [...fixtureViolations];
  for (const file of scannedFiles) {
    const path = relative(root, file).replaceAll("\\", "/");
    const text = readFileSync(file, "utf8");
    for (const rule of rules) {
      if (rule.appliesTo && !rule.appliesTo(path)) continue;
      if ((allow.get(rule.id) ?? []).some((pattern) => pattern.test(path))) continue;
      for (const match of text.matchAll(rule.pattern)) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push({ rule: rule.id, path, line, match: match[0] });
      }
    }
  }

  if (violations.length > 0) {
    console.error(JSON.stringify({ violations }, null, 2));
    process.exitCode = 1;
  } else {
    console.log(
      JSON.stringify(
        {
          negativeTypeDiagnostics: Object.fromEntries(diagnosticsByFixture),
          controlledFixtures: controlledFixtureRoots.map((directory) =>
            relative(root, directory).replaceAll("\\", "/"),
          ),
          scanned: scannedFiles.length,
          violations: 0,
        },
        null,
        2,
      ),
    );
  }
}

function runNegativeProbe(probe) {
  const fixtureByProbe = new Map([
    ["evidence-ref", "invalid-evidence-ref.ts.txt"],
    ["artifact-ref", "invalid-artifact-ref.ts.txt"],
    ["evidence-kind", "invalid-evidence-kind.ts.txt"],
    ["artifact-kind", "invalid-artifact-kind.ts.txt"],
  ]);
  const fixture = fixtureByProbe.get(probe);
  if (fixture) {
    const fixtureDiagnostics = diagnosticsByFixture.get(fixture) ?? [];
    return {
      probe,
      supported: true,
      rejected: fixtureDiagnostics.length === 1,
      fixture: `test/fixtures/evidence-surface/${fixture}`,
      diagnostics: fixtureDiagnostics,
    };
  }
  if (probe === "old-field") {
    const path = "packages/spark-ask/src/__negative-old-evidence-field.json";
    const text = JSON.stringify(evidenceSurfaceFixture.oldField);
    const rule = rules.find((candidate) => candidate.id === "artifact-ref-on-evidence-surface");
    const matches =
      rule && (!rule.appliesTo || rule.appliesTo(path)) ? [...text.matchAll(rule.pattern)] : [];
    return {
      probe,
      supported: true,
      rejected: matches.length > 0,
      fixture: "test/fixtures/evidence-surface/invalid-old-evidence-field.json",
      violations: matches.map((match) => ({ rule: rule.id, path, match: match[0] })),
    };
  }
  return {
    probe,
    supported: false,
    rejected: false,
    expected: ["evidence-ref", "artifact-ref", "evidence-kind", "artifact-kind", "old-field"],
  };
}

function readJsonFixture(path) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    throw new Error(`Invalid controlled Evidence fixture: ${path}`, { cause: error });
  }
}

function isInside(directory, file) {
  const scoped = relative(directory, file);
  return scoped === "" || (!scoped.startsWith("..") && !scoped.startsWith("/"));
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (["node_modules", ".svelte-kit", "dist", "build", "coverage", "reports"].includes(entry))
      continue;
    const path = resolve(directory, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx", ".js", ".mjs", ".svelte", ".md", ".json"].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
}
