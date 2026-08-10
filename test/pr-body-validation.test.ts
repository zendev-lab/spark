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
        "## 下一 PR",
        "",
        "Follow-up.",
        "",
      ].join("\n"),
      templatePath: new URL("../.github/pull_request_template.md", import.meta.url).pathname,
      stdout: capture.stdout,
    });
    expect(exitCode).toBe(0);
    expect(capture.read()).toContain('Required headings: ["动机","解决方案","说明","下一 PR"]');
  });
});
