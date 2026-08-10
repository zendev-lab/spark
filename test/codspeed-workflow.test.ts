import { access, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = new URL("../.github/workflows/ci-benchmarks.yml", import.meta.url);
const LEGACY_WORKFLOW_PATH = new URL("../.github/workflows/ci-verify.yml", import.meta.url);
const SEPARATE_WORKFLOW_PATH = new URL("../.github/workflows/codspeed.yml", import.meta.url);

async function workflowSource(): Promise<string> {
  return readFile(WORKFLOW_PATH, "utf8");
}

function benchmarkJob(source: string): string {
  const match = source.match(/^  lens:\n[\s\S]*$/mu);
  if (!match) {
    throw new Error("CI benchmarks workflow must define the Lens job");
  }
  return match[0];
}

describe("CodSpeed workflow contract", () => {
  it("keeps the benchmark in its dedicated read-only workflow", async () => {
    const source = await workflowSource();
    const job = benchmarkJob(source);
    await expect(access(LEGACY_WORKFLOW_PATH)).rejects.toThrow();
    await expect(access(SEPARATE_WORKFLOW_PATH)).rejects.toThrow();
    expect(source).toMatch(/^permissions:\n  contents: read$/mu);
    expect(job).not.toMatch(/^\s+id-token:/mu);
    expect(job).not.toMatch(/^\s+token:/mu);
    expect(job).not.toContain("secrets.");
  });

  it("pins every benchmark action to an immutable commit", async () => {
    const actions = [
      ...benchmarkJob(await workflowSource()).matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gmu),
    ].map((match) => match[1]);
    expect(actions).toHaveLength(4);
    for (const action of actions) {
      expect(action).toMatch(/@[a-f0-9]{40}$/u);
    }
    expect(actions).toContain("CodSpeedHQ/action@4296e51e7041e24dadb86d1d6e8b9320d223dbe8");
  });

  it("runs only the deterministic local Lens benchmark command", async () => {
    const job = benchmarkJob(await workflowSource());
    expect(job).toContain("node-version: 24");
    expect(job).toContain("--config.engine-strict=false");
    expect(job).toContain("mode: simulation");
    expect(job).toContain("run: pnpm run bench:lens:codspeed");
    expect(job).not.toMatch(/CODSPEED_TOKEN|api[_-]?key/iu);
  });
});
