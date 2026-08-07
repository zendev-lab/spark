import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TEMPLATE_PATH = ".github/pull_request_template.md";

// Keep the heading contract compatible with zendev validate-body v0.0.7.
export function extractH2Headings(markdown) {
  const headings = [];
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
    if (fence !== undefined) continue;

    const heading = line.trim().match(/^##\s+(\S.*)$/u);
    if (heading) headings.push(heading[1]);
  }

  return headings;
}

export function validatePrBody(body, template) {
  const expected = extractH2Headings(template);
  const actual = extractH2Headings(body);
  return {
    valid:
      expected.length > 0 &&
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    expected,
    actual,
  };
}

export async function runPrBodyValidation({
  body = process.env.PR_BODY ?? "",
  templatePath = DEFAULT_TEMPLATE_PATH,
  stdout = process.stdout,
} = {}) {
  const template = await readFile(templatePath, "utf8");
  const result = validatePrBody(body, template);

  stdout.write(
    `::group::PR / body check\nRequired headings: ${JSON.stringify(result.expected)}\n::endgroup::\n`,
  );
  if (result.valid) {
    stdout.write("PR body headings are valid.\n");
    return 0;
  }

  stdout.write("::error::PR body headings do not match the repository template.\n");
  stdout.write(`\n  Expected headings: ${JSON.stringify(result.expected)}\n`);
  stdout.write(`  Actual headings:   ${JSON.stringify(result.actual)}\n\n`);
  stdout.write("  Each PR body should contain exactly these H2 sections:\n");
  for (const heading of result.expected) stdout.write(`    ## ${heading}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPrBodyValidation({
    templatePath: process.argv[2] ?? DEFAULT_TEMPLATE_PATH,
  });
}
