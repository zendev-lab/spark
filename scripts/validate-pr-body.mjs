import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TEMPLATE_PATH = ".github/pull_request_template.md";
const SECTION_DIRECTIVE_RE = /^<!--\s*pr-body:(required|optional)\s*-->$/u;

// Keep this parser in lockstep with zendev's validate-body section contract.
function* linesOutsideFences(markdown) {
  let fence;

  for (const line of markdown.split(/\r?\n/u)) {
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/u);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === undefined) {
        fence = { character: marker[0], length: marker.length };
        continue;
      }
      if (
        marker[0] === fence.character &&
        marker.length >= fence.length &&
        fenceMatch[2].trim() === ""
      ) {
        fence = undefined;
      }
      continue;
    }
    if (fence === undefined) yield line;
  }
}

export function extractH2Headings(markdown) {
  const headings = [];
  for (const line of linesOutsideFences(markdown)) {
    const heading = line.trim().match(/^##\s+(\S.*)$/u);
    if (heading) headings.push(heading[1]);
  }
  return headings;
}

export function extractTemplateSections(template) {
  const sections = [];
  let pendingRequirement;

  for (const line of linesOutsideFences(template)) {
    const stripped = line.trim();
    const directive = stripped.match(SECTION_DIRECTIVE_RE);
    if (directive) {
      if (pendingRequirement !== undefined) {
        throw new Error("multiple pr-body directives appear before the same H2 section");
      }
      pendingRequirement = directive[1] === "required";
      continue;
    }

    const heading = stripped.match(/^##\s+(\S.*)$/u);
    if (!heading) continue;
    sections.push({
      heading: heading[1],
      required: pendingRequirement ?? true,
    });
    pendingRequirement = undefined;
  }

  if (pendingRequirement !== undefined) {
    throw new Error("pr-body directive is not followed by an H2 section");
  }

  const headings = sections.map((section) => section.heading);
  if (new Set(headings).size !== headings.length) {
    throw new Error("PR template H2 headings must be unique");
  }

  return sections;
}

export function validatePrBody(body, template) {
  const sections = extractTemplateSections(template);
  const expected = sections.map((section) => section.heading);
  const required = sections.filter((section) => section.required).map((section) => section.heading);
  const optional = sections
    .filter((section) => !section.required)
    .map((section) => section.heading);
  const actual = extractH2Headings(body);
  const positions = new Map(expected.map((heading, index) => [heading, index]));
  const actualPositions = actual.map((heading) => positions.get(heading));

  const unique = new Set(actual).size === actual.length;
  const declared = actualPositions.every((position) => position !== undefined);
  const ordered =
    declared &&
    actualPositions.every(
      (position, index) => index === 0 || position > actualPositions[index - 1],
    );
  const complete = required.every((heading) => actual.includes(heading));

  return {
    valid: expected.length > 0 && unique && declared && ordered && complete,
    expected,
    required,
    optional,
    actual,
  };
}

export async function runPrBodyValidation({
  body = process.env.PR_BODY ?? "",
  templatePath = DEFAULT_TEMPLATE_PATH,
  stdout = process.stdout,
} = {}) {
  const template = await readFile(templatePath, "utf8");
  let result;
  try {
    result = validatePrBody(body, template);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdout.write(`::error::Invalid PR template: ${message}\n`);
    return 1;
  }

  stdout.write(
    `::group::PR / body check\nTemplate headings: ${JSON.stringify(result.expected)}\nRequired headings: ${JSON.stringify(result.required)}\nOptional headings: ${JSON.stringify(result.optional)}\n::endgroup::\n`,
  );
  if (result.valid) {
    stdout.write("PR body headings are valid.\n");
    return 0;
  }

  stdout.write("::error::PR body headings do not match the repository template.\n");
  stdout.write(`\n  Template order:    ${JSON.stringify(result.expected)}\n`);
  stdout.write(`  Required headings: ${JSON.stringify(result.required)}\n`);
  stdout.write(`  Optional headings: ${JSON.stringify(result.optional)}\n`);
  stdout.write(`  Actual headings:   ${JSON.stringify(result.actual)}\n\n`);
  stdout.write("  Undeclared template H2 sections are required by default.\n");
  stdout.write("  Prefix an optional template section with <!-- pr-body:optional -->.\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPrBodyValidation({
    templatePath: process.argv[2] ?? DEFAULT_TEMPLATE_PATH,
  });
}
