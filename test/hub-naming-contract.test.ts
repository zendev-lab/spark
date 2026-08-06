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
  const [
    hubManifest,
    dbManifest,
    coordinationManifest,
    inventory,
    dependencyRules,
    rootManifest,
    dockerfile,
    verifyWorkflow,
    releaseWorkflow,
    npmDistributions,
    npmBuild,
    npmPolicy,
    containerHealthcheck,
  ] = await Promise.all([
    readJson("apps/spark-hub/package.json"),
    readJson("packages/spark-hub-db/package.json"),
    readJson("packages/spark-hub-coordination/package.json"),
    readFile(resolve(root, "architecture/packages.json"), "utf8"),
    readFile(resolve(root, ".dependency-cruiser.cjs"), "utf8"),
    readJson("package.json"),
    readFile(resolve(root, "Dockerfile"), "utf8"),
    readFile(resolve(root, ".github/workflows/ci-verify.yml"), "utf8"),
    readFile(resolve(root, ".github/workflows/cd-publish.yml"), "utf8"),
    readFile(resolve(root, "scripts/npm-distributions.mjs"), "utf8"),
    readFile(resolve(root, "scripts/build-npm-product.mjs"), "utf8"),
    readFile(resolve(root, "scripts/check-npm-product.mjs"), "utf8"),
    readFile(resolve(root, "scripts/container-healthcheck.mjs"), "utf8"),
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

  assert.match(dockerfile, /@zendev-lab\/spark-hub\/dist\/spark-hub-server\.js/u);
  assert.match(dockerfile, /spark-hub-v\*\.tgz/u);
  assert.doesNotMatch(dockerfile, /spark-cockpit/iu);

  assert.match(verifyWorkflow, /spark-hub:ci/u);
  assert.match(verifyWorkflow, /SPARK_HUB_PUBLIC_URL/u);
  assert.doesNotMatch(verifyWorkflow, /spark-cockpit|SPARK_COCKPIT/iu);

  assert.match(releaseWorkflow, /spark-hub-\$\{\{ github\.ref_name \}\}\.tgz/u);
  assert.match(releaseWorkflow, /scope=spark-hub/u);
  assert.doesNotMatch(releaseWorkflow, /spark-cockpit|SPARK_COCKPIT/iu);

  assert.match(npmDistributions, /@zendev-lab\/spark-hub/u);
  assert.match(npmDistributions, /migrationSource/u);
  assert.doesNotMatch(npmDistributions, /spark-cockpit|SPARK_COCKPIT/iu);

  assert.match(npmBuild, /SPARK_HUB_SERVER_ENTRYPOINT/u);
  assert.match(npmBuild, /apps\/spark-hub\/build/u);
  assert.doesNotMatch(npmBuild, /spark-cockpit|SPARK_COCKPIT/iu);

  assert.match(npmPolicy, /"spark-hub"/u);
  assert.match(npmPolicy, /@zendev-lab\/spark-hub/u);
  assert.match(npmPolicy, /must not expose the retired spark-cockpit executable/u);

  assert.match(containerHealthcheck, /body\?\.service === "spark-hub"/u);
  assert.match(containerHealthcheck, /SPARK_HUB_PUBLIC_URL/u);
  assert.match(containerHealthcheck, /SPARK_HUB_TRUST_PROXY/u);
});

async function readJson(path: string) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}
