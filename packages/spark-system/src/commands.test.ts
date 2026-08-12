import assert from "node:assert/strict";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { executableIdentityMatches, freezeExecutableIdentity } from "./commands.ts";

test("frozen executable identity rejects mutation and replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "spark-command-identity-"));
  const command = join(root, "command");
  const replacement = join(root, "replacement");
  try {
    await writeFile(command, "first", "utf8");
    await chmod(command, 0o700);
    const identity = freezeExecutableIdentity(command);
    assert.equal(executableIdentityMatches(identity), true);

    await writeFile(command, "changed", "utf8");
    assert.equal(executableIdentityMatches(identity), false);

    await writeFile(replacement, "first", "utf8");
    await chmod(replacement, 0o700);
    await rename(replacement, command);
    assert.equal(executableIdentityMatches(identity), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
