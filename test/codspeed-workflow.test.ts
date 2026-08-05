import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = new URL("../.github/workflows/codspeed.yml", import.meta.url);

async function workflowSource(): Promise<string> {
  return readFile(WORKFLOW_PATH, "utf8");
}

describe("CodSpeed workflow contract", () => {
  it("keeps the workflow read-only and free of credential inputs", async () => {
    const source = await workflowSource();
    expect(source).toMatch(/^permissions:\n  contents: read$/mu);
    expect(source).not.toMatch(/^\s+id-token:/mu);
    expect(source).not.toMatch(/^\s+token:/mu);
    expect(source).not.toContain("secrets.");
  });

  it("pins every action to an immutable commit", async () => {
    const source = await workflowSource();
    const actions = [...source.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gmu)].map(
      (match) => match[1],
    );
    expect(actions).toHaveLength(4);
    for (const action of actions) {
      expect(action).toMatch(/@[a-f0-9]{40}$/u);
    }
    expect(actions).toContain("CodSpeedHQ/action@0ca9cbbf4623b599a6c3ed4fc8a922942705d9f1");
  });

  it("runs only the deterministic local Lens benchmark command", async () => {
    const source = await workflowSource();
    expect(source).toContain("mode: simulation");
    expect(source).toContain("run: pnpm run bench:lens:codspeed");
    expect(source).not.toMatch(/CODSPEED_TOKEN|api[_-]?key/iu);
  });
});
