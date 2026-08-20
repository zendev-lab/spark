import assert from "node:assert/strict";
import { test, vi } from "vitest";

import { runSparkHubAppCli } from "../cli.ts";
import { runSparkHubCli } from "./hub.ts";

test("spark-hub dispatches coordination and web parser behavior in process", async () => {
  await assert.rejects(
    runSparkHubCli(["access", "not-a-real-op", "--json"]),
    /unknown spark hub access operation|create, list, or revoke/iu,
  );

  const stdout: string[] = [];
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  try {
    await assert.rejects(
      runSparkHubAppCli(["web", "not-a-real-op"]),
      /Unknown spark hub web command/u,
    );
    assert.equal(await runSparkHubAppCli(["web", "status", "--help"]), 0);
    assert.match(stdout.join(""), /spark hub web - manage the background Hub Web service/u);
    await assert.rejects(
      runSparkHubAppCli(["web", "logs", "--lines", "not-a-number"]),
      /Invalid --lines value\. Pass a non-negative integer\./u,
    );
  } finally {
    stdoutWrite.mockRestore();
  }
});
