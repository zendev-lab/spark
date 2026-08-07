import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  normalizePrTitle,
  runPrTitleValidation,
  validatePrTitle,
} from "../scripts/validate-pr-title.mjs";
import {
  extractH2Headings,
  runPrBodyValidation,
  validatePrBody,
} from "../scripts/validate-pr-body.mjs";

const template = "## Summary\n\nDescribe the change.\n\n## Notes\n\nAdd context.\n";

function captureOutput() {
  let output = "";
  return {
    stdout: { write: (chunk: string) => (output += chunk) },
    read: () => output,
  };
}

describe("PR workflow contract", () => {
  it("runs repository-owned validators without mutable nested action refs", async () => {
    const source = await readFile(
      new URL("../.github/workflows/ci-pr-checks.yml", import.meta.url),
      "utf8",
    );
    expect(source).toContain("pull_request:");
    expect(source).toContain("merge_group:");
    expect(source).toContain("renovate[bot]");
    expect(source).toContain("node scripts/validate-pr-title.mjs");
    expect(source).toContain("node scripts/validate-pr-body.mjs");
    expect(source).not.toContain("zendev/actions/validate-");
    const actions = [...source.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gmu)].map(
      (match) => match[1],
    );
    expect(actions).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]);
  });
});

describe("PR title validation", () => {
  it("requires the canonical emoji for each supported commit type", () => {
    expect(validatePrTitle("👷 ci: organize workflow checks")).toBe(true);
    expect(validatePrTitle("🐛 fix(parser): handle null token")).toBe(true);
    expect(validatePrTitle("feat: missing emoji")).toBe(false);
    expect(validatePrTitle("✨ fix: mismatched emoji")).toBe(false);
    expect(validatePrTitle("👷 ci: ")).toBe(false);
  });

  it("normalizes comments and allows git-generated prefixes like zendev", () => {
    expect(normalizePrTitle("👷 ci: organize workflow checks  \n# ignored\n")).toBe(
      "👷 ci: organize workflow checks",
    );
    expect(validatePrTitle('Revert "👷 ci: organize workflow checks"')).toBe(true);
  });

  it("emits an annotation for an invalid title", () => {
    const capture = captureOutput();
    expect(
      runPrTitleValidation({
        title: "ci: missing emoji",
        stdout: capture.stdout,
      }),
    ).toBe(1);
    expect(capture.read()).toContain(
      "::error::Title does not match zendev emoji commit conventions.",
    );
  });
});

describe("PR body validation", () => {
  it("requires exactly the template H2 headings in order", () => {
    expect(validatePrBody("## Summary\n\nDone.\n\n## Notes\n\nNone.\n", template)).toEqual({
      valid: true,
      expected: ["Summary", "Notes"],
      actual: ["Summary", "Notes"],
    });
    expect(validatePrBody("## Summary\n\nDone.\n", template).valid).toBe(false);
    expect(
      validatePrBody("## Summary\n\nDone.\n\n## Validation\n\nTests.\n\n## Notes\n", template)
        .valid,
    ).toBe(false);
    expect(validatePrBody("## Notes\n\nNone.\n\n## Summary\n\nDone.\n", template).valid).toBe(
      false,
    );
  });

  it("ignores headings inside backtick and tilde fences", () => {
    const markdown = [
      "## Summary",
      "```md",
      "## Hidden",
      "```",
      "~~~text",
      "## Also hidden",
      "~~~~",
      "## Notes",
    ].join("\n");
    expect(extractH2Headings(markdown)).toEqual(["Summary", "Notes"]);
  });

  it("fails closed when the template contains no H2 headings", () => {
    expect(validatePrBody("", "No sections here.")).toEqual({
      valid: false,
      expected: [],
      actual: [],
    });
  });

  it("prints the repository-compatible error for an invalid body", async () => {
    const capture = captureOutput();
    const exitCode = await runPrBodyValidation({
      body: "## Summary\n",
      templatePath: new URL("../.github/pull_request_template.md", import.meta.url).pathname,
      stdout: capture.stdout,
    });
    expect(exitCode).toBe(1);
    expect(capture.read()).toContain(
      "::error::PR body headings do not match the repository template.",
    );
    expect(capture.read()).toContain('Expected headings: ["Summary","Notes"]');
  });
});
