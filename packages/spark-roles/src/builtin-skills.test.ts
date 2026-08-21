import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";
import { defaultBasePromptDirs, defaultBuiltinSkillsDir } from "./builtin-skills.ts";

const temporaryDirectories: string[] = [];
const originalProductDist = process.env.SPARK_PRODUCT_DIST;

afterEach(async () => {
  if (originalProductDist === undefined) delete process.env.SPARK_PRODUCT_DIST;
  else process.env.SPARK_PRODUCT_DIST = originalProductDist;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

test("packaged Cue skills stay out of the legacy Spark resolver defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-product-skills-"));
  temporaryDirectories.push(root);
  const productDist = join(root, "dist");
  const skills = join(root, "skills");
  await mkdir(join(skills, "cue"), { recursive: true });
  process.env.SPARK_PRODUCT_DIST = productDist;

  const builtinSkills = join(root, "builtin-skills");
  expect(defaultBuiltinSkillsDir()).toBe(builtinSkills);
  expect(defaultBasePromptDirs()).toEqual([builtinSkills]);
});
