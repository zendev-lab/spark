import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export type JsonFileFormatErrorFactory = (filePath: string, message: string) => Error;

export function parseJsonFileText(
  text: string,
  filePath: string,
  createFormatError: JsonFileFormatErrorFactory,
): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw createFormatError(
      filePath,
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readJsonFileOptional(
  filePath: string,
  createFormatError: JsonFileFormatErrorFactory,
): Promise<unknown> {
  try {
    return parseJsonFileText(await readFile(filePath, "utf8"), filePath, createFormatError);
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    throw error;
  }
}

export async function readJsonFileRequired(
  filePath: string,
  createFormatError: JsonFileFormatErrorFactory,
): Promise<unknown> {
  return parseJsonFileText(await readFile(filePath, "utf8"), filePath, createFormatError);
}

export function formatJsonFile(value: unknown): string {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new TypeError("JSON file value must be serializable");
  return `${text}\n`;
}

export async function writeJsonFileAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextFileAtomic(filePath, formatJsonFile(value));
}

export async function writeTextFileAtomic(filePath: string, text: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, text, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await cleanupAtomicWriteTempFile(tempPath, error);
    throw error;
  }
}

async function cleanupAtomicWriteTempFile(tempPath: string, writeError: unknown): Promise<void> {
  try {
    await rm(tempPath, { force: true });
  } catch (cleanupError) {
    throw new Error(
      `atomic write failed and temporary file cleanup also failed: ${tempPath}; write error: ${unknownErrorMessage(writeError)}; cleanup error: ${unknownErrorMessage(cleanupError)}`,
    );
  }
}

function unknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isFileNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}
