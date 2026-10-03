import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatJsonFile,
  readJsonFileOptional,
  writeJsonFileAtomic,
  writeTextFileAtomic,
} from "./json-files.ts";

class TestJsonFormatError extends Error {
  readonly filePath: string;

  constructor(filePath: string, message: string) {
    super(`${filePath}: ${message}`);
    this.name = "TestJsonFormatError";
    this.filePath = filePath;
  }
}

describe("JSON and text file helpers", () => {
  it("preserves optional reads, formatting, atomic writes, and parse errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spark-platform-json-"));
    try {
      const filePath = join(dir, "nested", "state.json");
      const createError = (path: string, message: string) => new TestJsonFormatError(path, message);

      expect(await readJsonFileOptional(filePath, createError)).toBeUndefined();

      await writeJsonFileAtomic(filePath, { version: 1, enabled: true });
      expect(await readFile(filePath, "utf8")).toBe(formatJsonFile({ version: 1, enabled: true }));
      expect(await readJsonFileOptional(filePath, createError)).toEqual({
        version: 1,
        enabled: true,
      });

      const textPath = join(dir, "nested", "note.txt");
      await writeTextFileAtomic(textPath, "hello\n");
      expect(await readFile(textPath, "utf8")).toBe("hello\n");
      expect(
        (await readdir(join(dir, "nested"))).filter((entry) => entry.endsWith(".tmp")),
      ).toEqual([]);

      await writeFile(filePath, "{not-json", "utf8");
      await expect(readJsonFileOptional(filePath, createError)).rejects.toMatchObject({
        filePath,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects values that JSON cannot serialize", () => {
    expect(() => formatJsonFile(undefined)).toThrow("JSON file value must be serializable");
  });
});
