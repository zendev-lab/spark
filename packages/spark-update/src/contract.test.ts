import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isSparkBuildInfo } from "./build-info.ts";
import { readSparkUpdateState } from "./state.ts";

const fixtures = resolve(import.meta.dirname, "../fixtures");

describe("native deployment schema fixtures", () => {
  it("reads the same generation v2 state shape exposed by Rust", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spark-update-contract-"));
    const stateFile = join(directory, "state.json");
    const fixture = JSON.parse(await readFile(resolve(fixtures, "native-state-v2.json"), "utf8"));
    await writeFile(stateFile, `${JSON.stringify(fixture)}\n`);

    await expect(readSparkUpdateState({ stateFile })).resolves.toEqual(fixture);
  });

  it("accepts the native build-info fixture", async () => {
    const fixture = JSON.parse(await readFile(resolve(fixtures, "build-info-v2.json"), "utf8"));
    expect(isSparkBuildInfo(fixture)).toBe(true);
  });
});
