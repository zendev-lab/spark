import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";

const execFileAsync = promisify(execFile);

test("Lens release ratchet rejects public registration while the scorecard is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-lens-release-"));
  const source = join(directory, "registration.ts");
  await writeFile(source, "registerSparkTool(createSparkLensToolConfig());\n");

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["--experimental-strip-types", "scripts/check-lens-release.mts"],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          SPARK_LENS_REGISTRATION_SOURCE: source,
        },
      },
    ),
    (error: unknown) => {
      const failure = error as { stderr?: string };
      assert.match(failure.stderr ?? "", /Lens is public before every scorecard gate passes/u);
      return true;
    },
  );
});
