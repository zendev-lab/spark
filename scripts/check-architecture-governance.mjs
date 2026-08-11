import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const {
  formatArchitectureHealthMarkdown,
  generateArchitectureHealthReport,
  loadArchitectureInventory,
  readRootManifest,
  readWorkspaceManifests,
  validateArchitectureGovernance,
} = require("../architecture/dependency-governance.cjs");

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const knownArgs = new Set(["--check", "--write"]);
for (const arg of args) {
  if (!knownArgs.has(arg)) throw new Error(`Unknown architecture governance option: ${arg}`);
}

const inventory = loadArchitectureInventory(rootDir);
const rootManifest = readRootManifest(rootDir);
const manifests = readWorkspaceManifests(rootDir, inventory);
const failures = validateArchitectureGovernance(inventory, manifests, rootManifest);
const report = generateArchitectureHealthReport(rootDir, inventory, manifests);
const healthSchema = JSON.parse(
  await readFile(path.join(rootDir, "architecture/health.schema.json"), "utf8"),
);
const validateHealthReport = new Ajv2020({ allErrors: true, strict: true }).compile(healthSchema);

if (!validateHealthReport(report)) {
  failures.push(
    ...validateHealthReport.errors.map(
      (error) => `Architecture health schema ${error.instancePath || "/"} ${error.message}`,
    ),
  );
}
if (report.inventory.stateWriterFieldCount !== 0) {
  failures.push("Architecture inventory still contains stateWriter fields");
}
if (report.layerMatrix.missingDecisionCount !== 0) {
  failures.push("Architecture layer matrix has missing decisions");
}
if (report.dependencies.unregisteredViolations.length !== 0) {
  failures.push(
    `Architecture has ${report.dependencies.unregisteredViolations.length} unregistered layer violations`,
  );
}
if (report.dependencies.stronglyConnectedComponents.length !== 0) {
  failures.push(
    `Architecture has ${report.dependencies.stronglyConnectedComponents.length} production workspace dependency cycles`,
  );
}
if (
  report.compositionRoots.unexpected.length !== 0 ||
  report.compositionRoots.missing.length !== 0
) {
  failures.push("Architecture composition roots differ from the inventory contract");
}
if (report.piOwnership.violations.length !== 0) {
  failures.push(`Architecture has ${report.piOwnership.violations.length} Pi ownership violations`);
}

const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
const digest = createHash("sha256").update(serializedReport).digest("hex");
const compactMarkdown = formatArchitectureHealthMarkdown(report);
if (args.has("--write")) {
  const outputDir = path.join(rootDir, "reports/architecture");
  const outputPath = path.join(outputDir, "health.json");
  const markdownPath = path.join(outputDir, "health.md");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, serializedReport, "utf8");
  await writeFile(markdownPath, compactMarkdown, "utf8");
  console.log(`Architecture health report: ${path.relative(rootDir, outputPath)}`);
  console.log(`Architecture health markdown: ${path.relative(rootDir, markdownPath)}`);
}

console.log(
  `ARCHITECTURE_HEALTH ${JSON.stringify({
    digest,
    workspaceCount: report.inventory.workspaceCount,
    edgeCount: report.dependencies.edgeCount,
    registeredExceptions: report.dependencies.registeredExceptions.length,
    exceptionBudgetCurrent: report.temporaryDependencyExceptionBudget.current,
    exceptionBudgetCeiling: report.temporaryDependencyExceptionBudget.ceiling,
    crossOwnerEdges: report.dependencies.crossOwnerEdges.length,
    crossStateAuthorityEdges: report.dependencies.crossStateAuthorityEdges.length,
    unregisteredViolations: report.dependencies.unregisteredViolations.length,
    stronglyConnectedComponents: report.dependencies.stronglyConnectedComponents.length,
    piViolations: report.piOwnership.violations.length,
    unexpectedCompositionRoots: report.compositionRoots.unexpected.length,
  })}`,
);
console.log(compactMarkdown.trimEnd());

if (failures.length > 0) {
  console.error("Architecture governance check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Architecture governance check passed.");
}
