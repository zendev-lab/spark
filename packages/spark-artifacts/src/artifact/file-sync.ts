import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  isSparkDocumentMediaType,
  type SparkDocumentMediaType,
} from "@zendev-lab/spark-protocol/artifact-document";

import { ArtifactStore, defaultArtifactStore } from "./store.ts";
import type {
  Artifact,
  ArtifactFormat,
  ArtifactProgress,
  ArtifactRef,
  DocumentArtifactBody,
} from "./types.ts";

export const ARTIFACT_SYNC_FILE_MAX_BYTES = 32 * 1024;

export interface SyncDocumentArtifactFileInput {
  cwd: string;
  sourcePath: string;
  artifactRef: ArtifactRef;
  title: string;
  mediaType: SparkDocumentMediaType;
  progress?: ArtifactProgress;
  store?: ArtifactStore;
}

export interface SyncDocumentArtifactFileResult {
  artifact: Artifact<DocumentArtifactBody>;
  changed: boolean;
  created: boolean;
}

/**
 * Create or update one stable Document ref from a bounded cwd-local file.
 *
 * Identical visible state is a true no-op. Content/media changes advance the
 * document revision; title/progress/storage normalization can be persisted
 * without pretending that a new content revision exists.
 */
export async function syncDocumentArtifactFile(
  input: SyncDocumentArtifactFileInput,
): Promise<SyncDocumentArtifactFileResult> {
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  if (!isSparkDocumentMediaType(input.mediaType)) {
    throw new Error(`document media type is not writable: ${String(input.mediaType)}`);
  }
  const content = await readDocumentSyncFile(input.cwd, input.sourcePath);
  const store = input.store ?? defaultArtifactStore(input.cwd);
  const format = documentFormat(input.mediaType);
  const existing = await store.tryGet(input.artifactRef);
  if (!existing) {
    const created = await store.put({
      ref: input.artifactRef,
      kind: "document",
      title,
      format,
      body: {
        schemaVersion: 2,
        kind: "document",
        mediaType: input.mediaType,
        content,
        revision: 1,
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
      },
    });
    return { artifact: created, changed: true, created: true };
  }
  if (existing.body.kind !== "document") {
    throw new Error(`stable document ref belongs to ${existing.body.kind}: ${input.artifactRef}`);
  }
  const progress = input.progress ?? existing.body.progress;
  if (
    content === existing.body.content &&
    input.mediaType === existing.body.mediaType &&
    title === existing.title &&
    format === existing.format &&
    sameProgress(progress, existing.body.progress)
  ) {
    return {
      artifact: existing as Artifact<DocumentArtifactBody>,
      changed: false,
      created: false,
    };
  }

  const contentRevisionChanged =
    content !== existing.body.content || input.mediaType !== existing.body.mediaType;
  const updated = await store.update(input.artifactRef, {
    title,
    format,
    body: {
      ...existing.body,
      mediaType: input.mediaType,
      content,
      revision: existing.body.revision + (contentRevisionChanged ? 1 : 0),
      ...(progress !== undefined ? { progress } : {}),
    },
  });
  return { artifact: updated, changed: true, created: false };
}

export async function readDocumentSyncFile(cwd: string, sourcePathValue: unknown): Promise<string> {
  const sourcePath = requiredString(sourcePathValue, "sourcePath");
  const lexicalRoot = resolve(cwd);
  const candidate = resolve(lexicalRoot, sourcePath);
  if (!pathIsWithin(lexicalRoot, candidate)) {
    throw new Error(`sourcePath must stay within cwd: ${sourcePath}`);
  }

  const info = await lstat(candidate);
  if (info.isSymbolicLink()) {
    throw new Error(`sourcePath must not be a symbolic link: ${sourcePath}`);
  }
  if (!info.isFile()) {
    throw new Error(`sourcePath must be a regular file: ${sourcePath}`);
  }
  if (info.size > ARTIFACT_SYNC_FILE_MAX_BYTES) {
    throw syncFileSizeError(sourcePath, info.size);
  }

  const [canonicalRoot, canonicalSource] = await Promise.all([
    realpath(lexicalRoot),
    realpath(candidate),
  ]);
  if (!pathIsWithin(canonicalRoot, canonicalSource)) {
    throw new Error(`sourcePath must stay within cwd: ${sourcePath}`);
  }

  const handle = await open(canonicalSource, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) {
      throw new Error(`sourcePath must be a regular file: ${sourcePath}`);
    }
    if (openedInfo.size > ARTIFACT_SYNC_FILE_MAX_BYTES) {
      throw syncFileSizeError(sourcePath, openedInfo.size);
    }

    const buffer = Buffer.alloc(ARTIFACT_SYNC_FILE_MAX_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > ARTIFACT_SYNC_FILE_MAX_BYTES) {
      throw syncFileSizeError(sourcePath, bytesRead);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, bytesRead),
      );
    } catch {
      throw new Error(`sourcePath must contain valid UTF-8 text: ${sourcePath}`);
    }
  } finally {
    await handle.close();
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const scoped = relative(root, candidate);
  return scoped !== ".." && !scoped.startsWith(`..${sep}`) && !isAbsolute(scoped);
}

function syncFileSizeError(sourcePath: string, size: number): Error {
  return new Error(
    `sourcePath exceeds the ${ARTIFACT_SYNC_FILE_MAX_BYTES}-byte sync_file limit (${size} bytes): ${sourcePath}`,
  );
}

function documentFormat(mediaType: SparkDocumentMediaType): ArtifactFormat {
  switch (mediaType) {
    case "text/markdown":
      return "markdown";
    case "text/mdx":
      return "mdx";
    case "text/html":
      return "html";
    case "application/vnd.a2ui+json":
      return "json";
  }
}

function sameProgress(left: ArtifactProgress | undefined, right: ArtifactProgress | undefined) {
  return (
    left?.label === right?.label && left?.percent === right?.percent && left?.stage === right?.stage
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}
