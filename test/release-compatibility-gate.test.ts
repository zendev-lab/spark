import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  parseReleaseCompatibilityArguments,
  selectRequiredBaseline,
} from "../scripts/test-release-compatibility.mjs";

type ReleaseGateContract = {
  [key: string]: unknown;
  firstSplitRelease: string;
  releaseGate: {
    firstSplitReleaseException: { baselineVersion: string };
  };
};

async function contract(): Promise<ReleaseGateContract> {
  return JSON.parse(
    await readFile(join(process.cwd(), "architecture/release-compatibility.json"), "utf8"),
  ) as ReleaseGateContract;
}

test("requires every exact candidate distribution used by the canonical gate", () => {
  assert.throws(() => parseReleaseCompatibilityArguments([]), /--tarball is required/u);
  assert.deepEqual(
    parseReleaseCompatibilityArguments([
      "--tarball",
      "spark.tgz",
      "--cli-tarball",
      "cli.tgz",
      "--daemon-tarball",
      "daemon.tgz",
      "--hub-tarball",
      "hub.tgz",
      "--tui-tarball",
      "tui.tgz",
    ]),
    {
      tarball: "spark.tgz",
      cliTarball: "cli.tgz",
      daemonTarball: "daemon.tgz",
      hubTarball: "hub.tgz",
      tuiTarball: "tui.tgz",
    },
  );
});

test("fixes the first split baseline and then requires the newest published stable baseline", async () => {
  const value = await contract();
  assert.equal(selectRequiredBaseline(value, "0.3.0", ["0.2.0", "0.2.1"]), "0.2.1");
  assert.throws(
    () => selectRequiredBaseline(value, "0.3.0", ["0.2.1"], "0.2.0"),
    /fixed at 0.2.1/u,
  );
  assert.equal(
    selectRequiredBaseline(value, "0.5.0", ["0.2.1", "0.3.0", "0.4.0", "0.5.0-beta.1"]),
    "0.4.0",
  );
  assert.throws(
    () => selectRequiredBaseline(value, "0.5.0", ["0.3.0", "0.4.0"], "0.3.0"),
    /newest published stable baseline 0.4.0/u,
  );
});

test("rejects the legacy all-in-one package as a post-split baseline", async () => {
  const value = await contract();
  assert.throws(
    () => selectRequiredBaseline(value, "0.4.0", ["0.2.1"]),
    /published split-product baseline/u,
  );
});
