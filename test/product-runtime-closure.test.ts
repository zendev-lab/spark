import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import * as productRuntimeClosure from "../scripts/product-runtime-closure.mjs";

const { resolveProductRuntimeDependencies } = productRuntimeClosure;
const rootDir = join(import.meta.dirname, "..");

test("web-dsh host externals resolve from declared runtime dependencies", async () => {
  const productDirectory = await mkdtemp(join(tmpdir(), "spark-web-dsh-runtime-closure-"));
  const sandboxPackage = "@deepseek-ai/dsh-sandbox";

  try {
    await writeFile(join(productDirectory, "index.js"), `import "${sandboxPackage}";\n`, "utf8");

    const dependencies = await resolveProductRuntimeDependencies(rootDir, productDirectory);
    const installedManifest = JSON.parse(
      await readFile(
        join(rootDir, "apps", "spark-web-dsh", "node_modules", sandboxPackage, "package.json"),
        "utf8",
      ),
    );

    assert.equal(dependencies[sandboxPackage], installedManifest.version);
  } finally {
    await rm(productDirectory, { recursive: true, force: true });
  }
});
