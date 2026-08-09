import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { defaultEvidenceStore } from "./index.ts";

describe("Evidence body integrity", () => {
  it("rejects blob bytes that no longer match the Evidence hash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-evidence-integrity-"));
    const store = defaultEvidenceStore(cwd);
    const evidence = await store.put({
      kind: "record",
      title: "Integrity proof",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
    if (!evidence.blobPath) throw new Error("missing Evidence blobPath");
    const blobPath = join(cwd, ".spark", "evidence", evidence.blobPath);
    const body = JSON.parse(await readFile(blobPath, "utf8")) as Record<string, unknown>;
    body.passed = false;
    await writeFile(blobPath, JSON.stringify(body), "utf8");

    await expect(store.get(evidence.ref)).rejects.toThrow("evidence body hash mismatch");
  });
});
