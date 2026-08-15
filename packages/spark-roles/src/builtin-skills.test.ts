import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { defaultBuiltinSkillsDir, defaultSparkCueSkillsDir } from "./builtin-skills.ts";

const temporaryDirectories: string[] = [];
const originalProductDist = process.env.SPARK_PRODUCT_DIST;

afterEach(async () => {
  if (originalProductDist === undefined) delete process.env.SPARK_PRODUCT_DIST;
  else process.env.SPARK_PRODUCT_DIST = originalProductDist;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test("packaged skills resolve from the generated product root", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-product-skills-"));
  temporaryDirectories.push(root);
  const productDist = join(root, "dist");
  const skills = join(root, "skills");
  await mkdir(join(skills, "spark-cue"), { recursive: true });
  process.env.SPARK_PRODUCT_DIST = productDist;

  expect(defaultBuiltinSkillsDir()).toBe(skills);
  expect(defaultSparkCueSkillsDir()).toBe(join(skills, "spark-cue"));
});
