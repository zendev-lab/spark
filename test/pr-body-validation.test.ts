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
  it("uses pinned zendev validators without local runtime setup", async () => {
    const source = await readFile(
      new URL("../.github/workflows/ci-pr-checks.yml", import.meta.url),
      "utf8",
    );
    expect(source).toContain("pull_request:");
    expect(source).toContain("merge_group:");
    expect(source).toContain("renovate[bot]");
    expect(source).not.toContain("node scripts/validate-pr-title.mjs");
    expect(source).not.toContain("node scripts/validate-pr-body.mjs");
    expect(source).toContain(
      "zendev-lab/zendev/actions/validate-title@8f336868ce2cd685cfa8c62882acefc3acbb4ead",
    );
    expect(source).toContain(
      "zendev-lab/zendev/actions/validate-body@344af123be2442a48ae791935bf4df5f8fb2539b",
    );
    const actions = [...source.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gmu)].map(
      (match) => match[1],
    );
    expect(actions).toEqual([
      "zendev-lab/zendev/actions/validate-title@8f336868ce2cd685cfa8c62882acefc3acbb4ead",
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "zendev-lab/zendev/actions/validate-body@344af123be2442a48ae791935bf4df5f8fb2539b",
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

describe("legacy local PR body validation", () => {
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

  it("remains a strict compatibility parser, not the repository CI authority", async () => {
    const capture = captureOutput();
    const exitCode = await runPrBodyValidation({
      body: [
        "## 动机",
        "",
        "Reason.",
        "",
        "## 解决方案",
        "",
        "Change.",
        "",
        "## 说明",
        "",
        "Context.",
        "",
        "## 后续",
        "",
        "Follow-up.",
        "",
      ].join("\n"),
      templatePath: new URL("../.github/pull_request_template.md", import.meta.url).pathname,
      stdout: capture.stdout,
    });
    expect(exitCode).toBe(0);
    expect(capture.read()).toContain('Required headings: ["动机","解决方案","说明","后续"]');
  });
});
