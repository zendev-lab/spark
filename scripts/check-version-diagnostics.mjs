import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(root, "architecture", "version-diagnostics-baseline.json");
const updateBaseline = process.argv.includes("--update");
const sourceRoots = ["apps", "packages"];
const diagnosticContractPaths = new Set([
  "packages/spark-protocol/src/runtime-v1/diagnostics.ts",
  "packages/spark-protocol/src/version.ts",
  "packages/spark-protocol/src/versioned-data.ts",
]);
const sourceExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const diagnosticPropertyNames = new Set(["detail", "error", "message", "reason"]);

const candidatePattern =
  /(?:\bschema\s*version\b|\bschemaversion\b|\bprotocol\s+version\b|\bversion\s+mismatch\b|\bunsupported\b[^\n]{0,120}\b(?:schema|version)\b)/iu;
const receivedPattern = /\b(?:actual|encountered|found|got|received)\b/iu;
const supportedPattern =
  /\b(?:accepts?|compatible|expected|requires?|supported|supports|must\s+be)\b/iu;
const sourcePattern =
  /(?:\bat\b|\bfrom\b|\bboundary\b|\bconfig\b|\bdatabase\b|\bfile\b|\bmanifest\b|\bmessage\b|\bpath\b|\bpayload\b|\broute\b|\bsnapshot\b|\bstate\b|\bstore\b|\bwebsocket\b)/iu;
const actionPattern =
  /(?:\baction\b|\bdowngrade\b|\bmigrate\b|\bmove\s+aside\b|\breconnect\b|\bregenerate\b|\bremove\b|\brepair\b|\brestart\b|\bretry\b|\brerun\b|\bre-run\b|\bupgrade\b|\bupdate\b)/iu;

const violations = collectVersionDiagnosticViolations();
if (updateBaseline) {
  writeBaseline(violations);
  console.log(
    `Updated ${relative(root, baselinePath)} with ${violationCount(violations)} legacy weak version diagnostic(s).`,
  );
} else {
  checkBaseline(violations);
}

function collectVersionDiagnosticViolations() {
  const aggregate = new Map();
  for (const sourceRoot of sourceRoots) {
    visit(join(root, sourceRoot), (sourcePath) => {
      if (!isProductionSource(sourcePath)) return;
      const repositoryPath = relative(root, sourcePath).replaceAll("\\", "/");
      if (diagnosticContractPaths.has(repositoryPath)) return;
      const source = readFileSync(sourcePath, "utf8");
      const sourceFile = ts.createSourceFile(
        sourcePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKind(sourcePath),
      );
      const recordedContexts = new Set();

      function inspect(node) {
        if (isDiagnosticContext(node)) {
          const text = diagnosticContextText(node);
          if (candidatePattern.test(text)) {
            const start = node.getStart(sourceFile);
            if (!recordedContexts.has(start)) {
              recordedContexts.add(start);
              recordViolation(aggregate, repositoryPath, sourceFile, node, text);
            }
            return;
          }
        }
        ts.forEachChild(node, inspect);
      }

      inspect(sourceFile);
    });
  }
  return [...aggregate.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.fingerprint.localeCompare(right.fingerprint),
  );
}

function isDiagnosticContext(node) {
  if (ts.isThrowStatement(node)) return true;
  if (ts.isNewExpression(node)) return expressionLooksDiagnostic(node.expression);
  if (ts.isCallExpression(node)) return expressionLooksDiagnostic(node.expression);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        diagnosticPropertyNames.has(propertyName(property.name)),
    );
  }
  return false;
}

function expressionLooksDiagnostic(expression) {
  const name = expression.getText().toLowerCase();
  return /(?:error|fail|invalid|reject)/u.test(name);
}

function diagnosticContextText(node) {
  const fragments = [];
  function collect(current) {
    if (ts.isStringLiteralLike(current)) {
      fragments.push(current.text);
      return;
    }
    if (ts.isTemplateExpression(current)) {
      fragments.push(current.head.text);
      for (const span of current.templateSpans) {
        fragments.push("${value}", span.literal.text);
      }
      return;
    }
    ts.forEachChild(current, collect);
  }
  collect(node);
  return normalizeText(fragments.join(" "));
}

function recordViolation(aggregate, path, sourceFile, node, text) {
  const missing = [];
  if (!receivedPattern.test(text)) missing.push("received value");
  if (!supportedPattern.test(text)) missing.push("supported value");
  if (!sourcePattern.test(text)) missing.push("source/boundary");
  if (!actionPattern.test(text)) missing.push("recovery action");
  if (missing.length === 0) return;

  const fingerprint = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const key = `${path}:${fingerprint}`;
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const current = aggregate.get(key);
  if (current) {
    current.count += 1;
    current.lines.push(line);
    return;
  }
  aggregate.set(key, {
    path,
    fingerprint,
    count: 1,
    lines: [line],
    missing,
    message: text.length <= 320 ? text : `${text.slice(0, 317)}...`,
  });
}

function checkBaseline(current) {
  if (!existsSync(baselinePath)) {
    const proposed = baselineDocument(current);
    fail([
      `${relative(root, baselinePath)} is missing.`,
      "Review the exact initial debt inventory below, then commit it unchanged or improve the listed diagnostics first.",
      "INITIAL_BASELINE_JSON_BEGIN",
      JSON.stringify(proposed, null, 2),
      "INITIAL_BASELINE_JSON_END",
    ]);
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (baseline.version !== 1 || !Array.isArray(baseline.violations)) {
    fail([`${relative(root, baselinePath)} must contain version 1 and a violations array.`]);
    return;
  }

  const currentByKey = new Map(current.map((entry) => [entryKey(entry), entry]));
  const baselineByKey = new Map(baseline.violations.map((entry) => [entryKey(entry), entry]));
  const added = current.filter((entry) => {
    const accepted = baselineByKey.get(entryKey(entry));
    return !accepted || accepted.count !== entry.count;
  });
  const stale = baseline.violations.filter((entry) => {
    const observed = currentByKey.get(entryKey(entry));
    return !observed || observed.count !== entry.count;
  });

  if (added.length > 0 || stale.length > 0) {
    const failures = [];
    if (added.length > 0) {
      failures.push("New or expanded weak version diagnostics:", ...added.map(formatViolation));
    }
    if (stale.length > 0) {
      failures.push(
        "Stale baseline entries (diagnostic debt changed):",
        ...stale.map(formatViolation),
      );
    }
    failures.push(
      "Make each diagnostic state the received value, supported value, source/boundary, and recovery action. If legacy debt was intentionally reduced, regenerate the baseline with `node scripts/check-version-diagnostics.mjs --update` and review the diff.",
    );
    fail(failures);
    return;
  }

  console.log(
    `Version diagnostic ratchet passed (${violationCount(current)} inventoried legacy weak diagnostic(s); no unreviewed additions).`,
  );
}

function writeBaseline(current) {
  writeFileSync(baselinePath, `${JSON.stringify(baselineDocument(current), null, 2)}\n`, "utf8");
}

function baselineDocument(current) {
  return {
    version: 1,
    description:
      "Exact debt inventory for weak production version diagnostics. New entries are forbidden; remove entries by making diagnostics actionable.",
    violations: current,
  };
}

function formatViolation(entry) {
  const lines = Array.isArray(entry.lines) ? entry.lines.join(",") : "?";
  const missing = Array.isArray(entry.missing) ? entry.missing.join(", ") : "unknown fields";
  return `- ${entry.path}:${lines} ×${entry.count} [${missing}] ${JSON.stringify(entry.message)}`;
}

function entryKey(entry) {
  return `${entry.path}:${entry.fingerprint}`;
}

function violationCount(entries) {
  return entries.reduce((total, entry) => total + entry.count, 0);
}

function normalizeText(text) {
  return text.replace(/\s+/gu, " ").trim();
}

function propertyName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text.toLowerCase();
  return "";
}

function scriptKind(path) {
  switch (extname(path)) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function isProductionSource(path) {
  if (!sourceExtensions.has(extname(path))) return false;
  const normalized = path.replaceAll("\\", "/");
  return (
    !/(?:^|\/)(?:__fixtures__|__tests__|fixtures|generated|test|tests)(?:\/|$)/u.test(normalized) &&
    !/\.(?:spec|test)\.[^.]+$/u.test(normalized)
  );
}

function visit(path, callback) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    callback(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "build" ||
      entry.name === "dist" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    visit(join(path, entry.name), callback);
  }
}

function fail(lines) {
  console.error(["Version diagnostic ratchet failed:", ...lines].join("\n"));
  process.exitCode = 1;
}
