import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  normalizePrTitle,
  runPrTitleValidation,
  validatePrTitle,
} from "../scripts/validate-pr-title.mjs";
import {
  extractH2Headings,
  extractTemplateSections,
  runPrBodyValidation,
  validatePrBody,
} from "../scripts/validate-pr-body.mjs";

const template = [
  "## Why",
  "",
  "Explain the problem.",
  "",
  "## What changed",
  "",
  "Describe the change.",
  "",
  "<!-- pr-body:optional -->",
  "## Notes",
  "",
  "Add context.",
  "",
  "<!-- pr-body:optional -->",
  "## Next",
  "",
  "Describe follow-up work.",
].join("\n");

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
  it("defaults unmarked template H2 sections to required", () => {
    expect(extractTemplateSections("## Summary\n\n## Notes\n")).toEqual([
      { heading: "Summary", required: true },
      { heading: "Notes", required: true },
    ]);
  });

  it("allows optional sections to be omitted or included in template order", () => {
    const requiredOnly = "## Why\n\nReason.\n\n## What changed\n\nDone.\n";
    const withNext = `${requiredOnly}\n## Next\n\nFollow-up.\n`;
    const withAll = `${requiredOnly}\n## Notes\n\nNone.\n\n## Next\n\nFollow-up.\n`;

    expect(validatePrBody(requiredOnly, template)).toMatchObject({
      valid: true,
      required: ["Why", "What changed"],
      optional: ["Notes", "Next"],
      actual: ["Why", "What changed"],
    });
    expect(validatePrBody(withNext, template).valid).toBe(true);
    expect(validatePrBody(withAll, template).valid).toBe(true);
  });

  it("rejects missing required, extra, duplicate, and out-of-order sections", () => {
    const invalidBodies = [
      "## Why\n\nReason.\n",
      "## Why\n\nReason.\n\n## What changed\n\nDone.\n\n## Validation\n\nTests.\n",
      "## Why\n\nReason.\n\n## Why\n\nAgain.\n\n## What changed\n\nDone.\n",
      "## What changed\n\nDone.\n\n## Why\n\nReason.\n",
      "## Why\n\nReason.\n\n## Notes\n\nNone.\n\n## What changed\n\nDone.\n",
    ];

    for (const body of invalidBodies) expect(validatePrBody(body, template).valid).toBe(false);
  });

  it("ignores headings and requirement directives inside fences", () => {
    const markdown = [
      "## Why",
      "```md",
      "<!-- pr-body:optional -->",
      "## Hidden",
      "```",
      "~~~text",
      "## Also hidden",
      "~~~~",
      "## What changed",
    ].join("\n");
    expect(extractH2Headings(markdown)).toEqual(["Why", "What changed"]);
    expect(extractTemplateSections(markdown)).toEqual([
      { heading: "Why", required: true },
      { heading: "What changed", required: true },
    ]);
  });

  it("fails closed for empty or structurally ambiguous templates", () => {
    expect(validatePrBody("", "No sections here.").valid).toBe(false);
    expect(() =>
      extractTemplateSections("<!-- pr-body:optional -->\n<!-- pr-body:required -->\n## Why\n"),
    ).toThrow(/multiple pr-body directives/u);
    expect(() => extractTemplateSections("## Why\n\n<!-- pr-body:optional -->\n")).toThrow(
      /not followed by an H2/u,
    );
    expect(() => extractTemplateSections("## Why\n\n## Why\n")).toThrow(/must be unique/u);
  });

  it("prints required and optional headings for an invalid body", async () => {
    const capture = captureOutput();
    const exitCode = await runPrBodyValidation({
      body: "## Why\n",
      templatePath: new URL("../.github/pull_request_template.md", import.meta.url).pathname,
      stdout: capture.stdout,
    });
    expect(exitCode).toBe(1);
    expect(capture.read()).toContain(
      "::error::PR body headings do not match the repository template.",
    );
    expect(capture.read()).toContain('Required headings: ["Why","What changed"]');
    expect(capture.read()).toContain('Optional headings: ["Notes","Next"]');
  });
});
