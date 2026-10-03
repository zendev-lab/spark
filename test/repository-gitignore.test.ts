import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

test("repository gitignore keeps local .spark stores untracked", async () => {
  const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /^\.spark\/$/m);
});

test("repository gitignore versions project .agents definitions and ignores worktrees", async () => {
  const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");
  assert.match(gitignore, /^\.agents\/worktrees\/$/m);
  assert.doesNotMatch(gitignore, /^\.agents\/$/m);
  const nested = await readFile(join(process.cwd(), ".agents/.gitignore"), "utf8");
  assert.match(nested, /^worktrees\/$/m);
});
