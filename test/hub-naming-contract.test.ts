import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "vitest";

const root = resolve(".");

test("tracked app and package inventory uses physical Hub names", async () => {
  const tracked = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n");

  assert.equal(
    tracked.some((path) => path.startsWith("apps/spark-hub/")),
    true,
  );
  assert.equal(
    tracked.some((path) => path.startsWith("packages/spark-hub-db/")),
    true,
  );
  assert.equal(
    tracked.some((path) => path.startsWith("packages/spark-hub-coordination/")),
    true,
  );
  assert.equal(
    tracked.some((path) => /^apps\/spark-cockpit(?:\/|$)/u.test(path)),
    false,
  );
  assert.equal(
    tracked.some((path) => /^packages\/spark-cockpit-(?:db|coordination)(?:\/|$)/u.test(path)),
    false,
  );
});

test("manifests, architecture inventory, build, deployment, and dependency rules name Hub", async () => {
  const [hubManifest, dbManifest, coordinationManifest, inventory, dependencyRules, rootManifest] =
    await Promise.all([
      readJson("apps/spark-hub/package.json"),
      readJson("packages/spark-hub-db/package.json"),
      readJson("packages/spark-hub-coordination/package.json"),
      readFile(resolve(root, "architecture/packages.json"), "utf8"),
      readFile(resolve(root, ".dependency-cruiser.cjs"), "utf8"),
      readJson("package.json"),
    ]);

  assert.equal(hubManifest.name, "@zendev-lab/spark-hub");
  assert.deepEqual(hubManifest.bin, { "spark-hub": "./bin/spark-hub" });
  assert.equal(dbManifest.name, "@zendev-lab/spark-hub-db");
  assert.equal(coordinationManifest.name, "@zendev-lab/spark-hub-coordination");
  assert.match(inventory, /apps\/spark-hub/u);
  assert.match(inventory, /packages\/spark-hub-db/u);
  assert.match(inventory, /packages\/spark-hub-coordination/u);
  assert.doesNotMatch(inventory, /spark-cockpit/iu);
  assert.match(dependencyRules, /hub-no-app-internals/u);
  assert.doesNotMatch(dependencyRules, /spark-cockpit/iu);
  assert.match(JSON.stringify(rootManifest.scripts), /test:browser:hub/u);
  assert.doesNotMatch(JSON.stringify(rootManifest.scripts), /cockpit/iu);
});

async function readJson(path: string) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}
