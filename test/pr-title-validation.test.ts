import { describe, expect, it } from "vitest";

import {
  normalizePrTitle,
  runPrTitleValidation,
  validatePrTitle,
} from "../scripts/validate-pr-title.mjs";

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
