import { readFile } from "node:fs/promises";
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

describe("PR workflow contract", () => {
  it("pins the zendev PR-body validator while keeping the local title validator", async () => {
    const source = await readFile(
      new URL("../.github/workflows/ci-pr-checks.yml", import.meta.url),
      "utf8",
    );
    expect(source).toContain("pull_request:");
    expect(source).toContain("merge_group:");
    expect(source).toContain("renovate[bot]");
    expect(source).toContain("node scripts/validate-pr-title.mjs");
    expect(source).toContain(
      "zendev-lab/zendev/actions/validate-body@344af123be2442a48ae791935bf4df5f8fb2539b",
    );
    expect(source).not.toContain("node scripts/validate-pr-body.mjs");
    const actions = [...source.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gmu)].map(
      (match) => match[1],
    );
    expect(actions).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
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
