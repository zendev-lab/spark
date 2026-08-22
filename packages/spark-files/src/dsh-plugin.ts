import type { Context } from "@deepseek-ai/cordis";
import { FsError, type FsTarget, type FsVersion, type FsWriteIntent } from "@deepseek-ai/dsh-fs";
import { defineTool, type ToolDefinition, type ToolRunContext } from "@deepseek-ai/dsh-tools";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-sandbox-policy";
import type {} from "@deepseek-ai/dsh-system-prompt";

import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
  type FileEdit,
} from "./edit-diff.ts";
import { createFileReadMetadata } from "./file-version.ts";
import { DEFAULT_READ_MAX_BYTES, DEFAULT_READ_MAX_LINES, splitTextLines } from "./truncate.ts";

export const name = "spark-files-dsh";
export const inject = ["tools", "fs", "systemPrompt", "sandboxPolicy"];

const MISSING_VERSION = "missing";
const PROVIDER_VERSION_PREFIX = "dshfs:v1:";
const MAX_SNAPSHOT_RETRIES = 2;

interface VersionedSnapshot {
  target: FsTarget;
  content: string;
  version: FsVersion;
  sizeBytes: number;
}

interface ReadLine {
  number: number;
  hash: string;
  anchor: string;
  text: string;
}

interface ReadValue {
  path: string;
  version: string;
  sizeBytes: number;
  offset: number;
  lines: ReadLine[];
  totalLines: number;
  nextOffset?: number;
  notice?: string;
}

const readOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    version: { type: "string", required: true },
    sizeBytes: { type: "integer", required: true },
    offset: { type: "integer", required: true },
    lines: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          number: { type: "integer", required: true },
          hash: { type: "string", required: true },
          anchor: { type: "string", required: true },
          text: { type: "string", required: true },
        },
      },
    },
    totalLines: { type: "integer", required: true },
    nextOffset: { type: "integer" },
    notice: { type: "string" },
  },
} as const;

const mutationOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    operation: { type: "string", enum: ["create", "update"], required: true },
    version: { type: "string", required: true },
    previousVersion: { type: "string", required: true },
    sizeBytes: { type: "integer", required: true },
    before: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    after: { type: "string", required: true },
  },
} as const;

const editOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    version: { type: "string", required: true },
    previousVersion: { type: "string", required: true },
    before: { type: "string", required: true },
    after: { type: "string", required: true },
    patch: { type: "string", required: true },
  },
} as const;

function requiredPath(path: string): string {
  if (path.trim() === "") throw new Error("path must be a non-empty string");
  return path;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function callingSession(exec: ToolRunContext) {
  if (exec.agent === undefined) {
    throw new Error("Spark file tools require a DSH Agent and Session");
  }
  return exec.agent.session;
}

function resolveOptions(ctx: Context, exec: ToolRunContext): { cwd: string; signal: AbortSignal } {
  const session = callingSession(exec);
  return { cwd: session.header.cwd ?? ctx.sandboxPolicy.workspaceRoot, signal: exec.signal };
}

function encodeProviderVersion(version: FsVersion): string {
  return `${PROVIDER_VERSION_PREFIX}${Buffer.from(version, "utf8").toString("base64url")}`;
}

function decodeProviderVersion(expectedVersion: string): FsVersion {
  if (!expectedVersion.startsWith(PROVIDER_VERSION_PREFIX)) {
    throw new Error("expectedVersion must be the exact opaque version returned by read");
  }
  const encoded = expectedVersion.slice(PROVIDER_VERSION_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("expectedVersion must be the exact opaque version returned by read");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  if (decoded === "" || Buffer.from(decoded, "utf8").toString("base64url") !== encoded) {
    throw new Error("expectedVersion must be the exact opaque version returned by read");
  }
  return decoded as FsVersion;
}

function versionIntent(expectedVersion: string): FsWriteIntent {
  if (expectedVersion === MISSING_VERSION) return { kind: "createIfAbsent" };
  return { kind: "replaceIfVersion", version: decodeProviderVersion(expectedVersion) };
}

function versionsMatch(left: FsVersion, right: FsVersion): boolean {
  return left === right;
}

function assertLegacySandboxArgsAreSafe(args: unknown, effectiveMode: string): void {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return;
  const record = args as Record<string, unknown>;
  const requestedMode = record.sandbox_permissions;
  const justification = record.justification;
  if (requestedMode === undefined && justification === undefined) return;
  // rc.8 schemas may leave a same-mode retry in an already-built model call.
  // Treat only that exact duplicate as idempotent; never swallow a downgrade
  // or a genuine escalation request and then execute under broader authority.
  if (requestedMode === effectiveMode) return;
  throw new Error(
    `sandbox_permissions is not supported by Spark file tools (current mode: ${effectiveMode}); change the session sandbox policy before retrying`,
  );
}

function remapMutationError(error: unknown): never {
  if (!(error instanceof FsError)) throw error;
  if (error.code === "FS_STALE_VERSION" || error.code === "FS_NOT_OBSERVED") {
    throw new FsError(
      `${error.message} — re-read the file, rebuild the change, then retry`,
      error.code,
      {
        cause: error,
      },
    );
  }
  if (error.code === "FS_SANDBOX_DENIED") {
    throw new FsError(
      `${error.message} — use a path allowed by the current session sandbox or change the session sandbox policy before retrying`,
      error.code,
      { cause: error },
    );
  }
  throw error;
}

async function readVersionedSnapshot(
  ctx: Context,
  path: string,
  exec: ToolRunContext,
): Promise<VersionedSnapshot> {
  const target = await ctx.fs.resolve(path, resolveOptions(ctx, exec));
  for (let attempt = 0; attempt < MAX_SNAPSHOT_RETRIES; attempt += 1) {
    const before = await ctx.fs.stat(target, exec.signal);
    if (before === undefined) {
      ctx.emit("fs/observed", target, { kind: "absent" }, exec);
      throw new FsError(`cannot read "${target.displayPath}": not found`, "FS_NOT_FOUND");
    }
    if (before.type !== "file") {
      throw new FsError(
        `cannot read "${target.displayPath}": not a regular file`,
        "FS_NOT_REGULAR_FILE",
      );
    }
    const content = await ctx.fs.readText(target, exec.signal);
    const after = await ctx.fs.stat(target, exec.signal);
    if (
      after !== undefined &&
      after.type === "file" &&
      versionsMatch(before.version, after.version)
    ) {
      return {
        target,
        content,
        version: after.version,
        sizeBytes: Buffer.byteLength(content, "utf8"),
      };
    }
  }
  throw new FsError(
    `cannot read "${target.displayPath}": file changed while it was being read; retry`,
    "FS_STALE_VERSION",
  );
}

function readWindow(snapshot: VersionedSnapshot, offset?: number, limit?: number): ReadValue {
  const requestedOffset = positiveInteger(offset, "offset");
  const requestedLimit = positiveInteger(limit, "limit");
  if (requestedLimit !== undefined && requestedLimit > DEFAULT_READ_MAX_LINES) {
    throw new Error(`limit must be less than or equal to ${DEFAULT_READ_MAX_LINES}`);
  }

  const buffer = Buffer.from(snapshot.content, "utf8");
  const allLines = splitTextLines(snapshot.content).map((line) => line.text);
  const windowLimit = requestedLimit ?? DEFAULT_READ_MAX_LINES;
  const startLineIndex =
    requestedOffset === undefined
      ? Math.max(0, allLines.length - windowLimit)
      : requestedOffset - 1;
  if (startLineIndex >= allLines.length) {
    throw new Error(
      `offset ${requestedOffset} is out of range for "${snapshot.target.displayPath}" (${allLines.length} lines)`,
    );
  }

  const available = Math.min(windowLimit, allLines.length - startLineIndex);
  const metadata = createFileReadMetadata({
    buffer,
    lines: allLines,
    startLineIndex,
    outputLineCount: available,
    requestedLimit,
  });
  const anchors: typeof metadata.window.anchors = [];
  let outputBytes = Buffer.byteLength(
    `[File version: ${encodeProviderVersion(snapshot.version)}]\n\n`,
    "utf8",
  );
  for (const anchor of metadata.window.anchors) {
    const separatorBytes = anchors.length === 0 ? 0 : 1;
    const anchorBytes = Buffer.byteLength(anchor.anchor, "utf8");
    // Reserve room for the continuation notice so the complete rendered
    // result, not just the file lines, stays inside the owner cap.
    if (outputBytes + separatorBytes + anchorBytes + 512 > DEFAULT_READ_MAX_BYTES) break;
    anchors.push(anchor);
    outputBytes += separatorBytes + anchorBytes;
  }
  const outputLineCount = anchors.length;

  const endExclusive = startLineIndex + outputLineCount;
  let nextOffset: number | undefined;
  let notice: string | undefined;
  if (endExclusive < allLines.length) {
    nextOffset = endExclusive + 1;
    notice = `[Showing lines ${startLineIndex + 1}-${endExclusive} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
  } else if (requestedOffset === undefined && startLineIndex > 0) {
    notice = `[Showing lines ${startLineIndex + 1}-${endExclusive} of ${allLines.length} (last page). Use offset=1 to read from the beginning.]`;
  }
  if (outputLineCount === 0) {
    notice = `[Line ${startLineIndex + 1} plus its read anchor exceeds the ${DEFAULT_READ_MAX_BYTES}-byte output limit.]`;
  }

  return {
    path: snapshot.target.displayPath,
    version: encodeProviderVersion(snapshot.version),
    sizeBytes: snapshot.sizeBytes,
    offset: startLineIndex + 1,
    lines: anchors.map(({ line, hash, anchor, text }) => ({
      number: line,
      hash,
      anchor,
      text,
    })),
    totalLines: allLines.length,
    ...(nextOffset === undefined ? {} : { nextOffset }),
    ...(notice === undefined ? {} : { notice }),
  };
}

function renderRead(value: ReadValue): string {
  return [
    `[File version: ${value.version}]`,
    value.lines.map((line) => line.anchor).join("\n"),
    value.notice,
  ]
    .filter((section): section is string => section !== undefined && section !== "")
    .join("\n\n");
}

function diffMeta(path: string, before: string | null, after: string) {
  return {
    diffs: [{ path, oldText: before, newText: after }],
  };
}

export function createDshFileToolDefinitions(ctx: Context): ToolDefinition[] {
  const read = defineTool({
    name: "read",
    description: `Read one versioned UTF-8 snapshot with stable LINE#HASH anchors. Results are capped at ${DEFAULT_READ_MAX_LINES} lines and ${DEFAULT_READ_MAX_BYTES / 1024}KB; without a window, the last page is returned.`,
    parameters: {
      path: { type: "string", required: true, description: "Path to read." },
      offset: { type: "integer", description: "1-based first line to return." },
      limit: {
        type: "integer",
        description: `Maximum lines to return, up to ${DEFAULT_READ_MAX_LINES}.`,
      },
      expectedVersion: {
        type: "string",
        description: "Optional exact opaque version returned by an earlier read.",
      },
    },
    output: {
      schema: readOutputSchema,
      render: (_args, value) => [{ type: "text", text: renderRead(value) }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        offset: value.offset,
        lines: value.lines.map(({ number, text }) => ({ number, text })),
        totalLines: value.totalLines,
      }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const path = requiredPath(args.path);
      const snapshot = await readVersionedSnapshot(ctx, path, exec);
      if (
        args.expectedVersion !== undefined &&
        args.expectedVersion !== encodeProviderVersion(snapshot.version)
      ) {
        throw new FsError(
          `cannot read "${snapshot.target.displayPath}": file version changed; re-read without expectedVersion`,
          "FS_STALE_VERSION",
        );
      }
      const value = readWindow(snapshot, args.offset, args.limit);
      ctx.emit(
        "fs/observed",
        snapshot.target,
        { kind: "present", version: snapshot.version },
        exec,
      );
      return value;
    },
    presentCall: (args) => ({
      card: "generic",
      title: `Read ${args.path}`,
      kind: "read",
      locations: [{ path: args.path, line: args.offset ?? 1 }],
    }),
  });

  const write = defineTool({
    name: "write",
    description:
      "Atomically create or replace a UTF-8 file with an explicit optimistic-concurrency precondition. Use expectedVersion='missing' for create-only, or the exact opaque version returned by read for replacement.",
    parameters: {
      path: { type: "string", required: true, description: "Path to write." },
      content: { type: "string", required: true, description: "Complete literal file content." },
      expectedVersion: {
        type: "string",
        required: true,
        description: "Exact version returned by read, or 'missing' for create-only intent.",
      },
    },
    output: {
      schema: mutationOutputSchema,
      render: (_args, value) => [
        {
          type: "text",
          text: `Successfully ${value.operation === "create" ? "created" : "wrote"} ${value.path}\n[File version: ${value.version}]`,
        },
      ],
      presentationMeta: (_args, value) => diffMeta(value.path, value.before, value.after),
    },
    async execute(args, exec) {
      const path = requiredPath(args.path);
      const session = callingSession(exec);
      const policy = ctx.sandboxPolicy.resolve({ session });
      assertLegacySandboxArgsAreSafe(args, policy.mode);
      const target = await ctx.fs.resolve(path, {
        cwd: session.header.cwd ?? policy.workspaceRoot,
        signal: exec.signal,
      });
      const intent = versionIntent(args.expectedVersion);
      try {
        const outcome = await ctx.fs.writeText(target, args.content, intent, exec.signal, policy);
        ctx.emit("fs/observed", target, { kind: "present", version: outcome.version }, exec);
        return {
          path: target.displayPath,
          operation: outcome.operation,
          version: encodeProviderVersion(outcome.version),
          previousVersion: args.expectedVersion,
          sizeBytes: Buffer.byteLength(outcome.after, "utf8"),
          before: outcome.before,
          after: outcome.after,
        };
      } catch (error) {
        remapMutationError(error);
      }
    },
    presentCall: (args) => ({
      card: "diff",
      title: `Write ${args.path}`,
      diffs: [{ path: args.path, oldText: null, newText: args.content }],
      locations: [{ path: args.path }],
    }),
  });

  const edit = defineTool({
    name: "edit",
    description:
      "Atomically apply one or more unique, non-overlapping text replacements to the exact file version returned by read.",
    parameters: {
      path: { type: "string", required: true, description: "Path to edit." },
      edits: {
        type: "array",
        required: true,
        description: "Replacements matched against the same original snapshot.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            oldText: { type: "string", required: true },
            newText: { type: "string", required: true },
          },
        },
      },
      expectedVersion: {
        type: "string",
        required: true,
        description: "Exact opaque version returned by read.",
      },
    },
    output: {
      schema: editOutputSchema,
      render: (_args, value) => [
        {
          type: "text",
          text: `Successfully edited ${value.path}\n[File version: ${value.version}]`,
        },
      ],
      presentationMeta: (_args, value) => diffMeta(value.path, value.before, value.after),
    },
    async execute(args, exec) {
      const path = requiredPath(args.path);
      if (args.expectedVersion === MISSING_VERSION) {
        throw new Error("edit.expectedVersion must be the exact version returned by read");
      }
      const expectedProviderVersion = decodeProviderVersion(args.expectedVersion);
      if (args.edits.length === 0) throw new Error("edits must contain at least one replacement");
      const session = callingSession(exec);
      const policy = ctx.sandboxPolicy.resolve({ session });
      assertLegacySandboxArgsAreSafe(args, policy.mode);
      const snapshot = await readVersionedSnapshot(ctx, path, exec);
      if (snapshot.version !== expectedProviderVersion) {
        throw new FsError(
          `cannot edit "${snapshot.target.displayPath}": file changed since it was read`,
          "FS_STALE_VERSION",
        );
      }

      const { bom, text } = stripBom(snapshot.content);
      const originalEnding = detectLineEnding(text);
      const normalized = normalizeToLF(text);
      const { baseContent, newContent } = applyEditsToNormalizedContent(
        normalized,
        args.edits as FileEdit[],
        snapshot.target.displayPath,
      );
      const finalContent = bom + restoreLineEndings(newContent, originalEnding);
      try {
        const outcome = await ctx.fs.writeText(
          snapshot.target,
          finalContent,
          { kind: "replaceIfVersion", version: snapshot.version },
          exec.signal,
          policy,
        );
        ctx.emit(
          "fs/observed",
          snapshot.target,
          { kind: "present", version: outcome.version },
          exec,
        );
        return {
          path: snapshot.target.displayPath,
          version: encodeProviderVersion(outcome.version),
          previousVersion: args.expectedVersion,
          before: snapshot.content,
          after: finalContent,
          patch: generateUnifiedPatch(snapshot.target.displayPath, baseContent, newContent),
        };
      } catch (error) {
        remapMutationError(error);
      }
    },
    presentCall: (args) => ({
      card: "diff",
      title: `Edit ${args.path}`,
      diffs: args.edits.map((item) => ({
        path: args.path,
        oldText: item.oldText,
        newText: item.newText,
      })),
      locations: [{ path: args.path }],
    }),
  });

  return [read, write, edit];
}

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: "tool:read",
    order: 100,
    text: "Use read for UTF-8 files. Preserve the returned opaque file version and LINE#HASH anchors; remove anchors when writing literal content.",
  });
  ctx.systemPrompt.section({
    name: "tool:write",
    order: 101,
    text: "Use write for complete file creation or replacement. Every call requires expectedVersion: use 'missing' for a new file or the exact version returned by read.",
  });
  ctx.systemPrompt.section({
    name: "tool:edit",
    order: 102,
    text: "Use edit for targeted replacements. Read first, pass that exact expectedVersion, and combine disjoint replacements into one edits array.",
  });
  for (const tool of createDshFileToolDefinitions(ctx)) ctx.tools.register(tool);
}
