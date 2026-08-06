import { pathToFileURL } from "node:url";

// Keep this map and title grammar compatible with zendev validate-title v0.0.7.
const TYPE_EMOJI = new Map([
  ["init", "🎉"],
  ["feat", "✨"],
  ["fix", "🐛"],
  ["docs", "📝"],
  ["refactor", "♻️"],
  ["test", "✅"],
  ["ci", "👷"],
  ["perf", "⚡"],
  ["chore", "🔧"],
  ["style", "🎨"],
  ["build", "📦"],
]);
const SPECIAL_PREFIXES = ["Merge ", "Revert ", "fixup! ", "squash! "];
const TITLE_PATTERN =
  /^(\S+) (init|feat|fix|docs|refactor|test|ci|perf|chore|style|build)(?:\(\S+\))?!?: ([^\n\r]+)$/u;

export function normalizePrTitle(title) {
  return title
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

export function validatePrTitle(title) {
  const normalized = normalizePrTitle(title);
  if (!normalized) return false;
  if (SPECIAL_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;

  const match = normalized.match(TITLE_PATTERN);
  return match !== null && TYPE_EMOJI.get(match[2]) === match[1];
}

export function runPrTitleValidation({
  title = process.env.PR_TITLE ?? "",
  stdout = process.stdout,
} = {}) {
  const normalized = normalizePrTitle(title);
  stdout.write(`::group::PR / title check\nText: ${JSON.stringify(normalized)}\n::endgroup::\n`);
  if (validatePrTitle(normalized)) {
    stdout.write("Title format is valid.\n");
    return 0;
  }

  stdout.write("::error::Title does not match zendev emoji commit conventions.\n");
  stdout.write("Expected: <emoji> <type>(<scope>): <description>\n");
  stdout.write(`Received: ${JSON.stringify(normalized.split(/\r?\n/u)[0] ?? "")}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runPrTitleValidation();
}
