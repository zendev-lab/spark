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
    await expect(store.list()).rejects.toThrow("evidence body hash mismatch");
  });

  it("canonicalizes string bodies written with the JSON format", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-evidence-json-string-"));
    const store = defaultEvidenceStore(cwd);
    const evidence = await store.put({
      kind: "record",
      title: "Canonical JSON",
      format: "json",
      body: '{"passed":true}',
      provenance: { producer: "spark" },
    });
    if (!evidence.blobPath) throw new Error("missing Evidence blobPath");
    const blobPath = join(cwd, ".spark", "evidence", evidence.blobPath);
    const serialized = await readFile(blobPath, "utf8");
    expect(JSON.parse(serialized)).toEqual({ passed: true });
    await expect(store.get(evidence.ref)).resolves.toMatchObject({
      body: { passed: true },
    });
  });

  it("serializes invalid JSON strings as valid JSON string values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-evidence-invalid-json-string-"));
    const store = defaultEvidenceStore(cwd);
    const evidence = await store.put({
      kind: "record",
      title: "Invalid JSON string",
      format: "json",
      body: "not JSON",
      provenance: { producer: "spark" },
    });
    if (!evidence.blobPath) throw new Error("missing Evidence blobPath");
    const blobPath = join(cwd, ".spark", "evidence", evidence.blobPath);
    expect(JSON.parse(await readFile(blobPath, "utf8"))).toBe("not JSON");
  });

  it("rejects blob-backed Evidence without a metadata hash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "spark-evidence-missing-hash-"));
    const store = defaultEvidenceStore(cwd);
    const evidence = await store.put({
      kind: "record",
      title: "Integrity proof",
      format: "json",
      body: { passed: true },
      provenance: { producer: "spark" },
    });
    const metadataPath = store.pathFor(evidence.ref);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    delete metadata.hash;
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");

    await expect(store.get(evidence.ref)).rejects.toThrow("evidence blob metadata hash is missing");
  });
});
