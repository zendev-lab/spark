import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import type {
  SessionFollowFrame,
  SessionFollowRequest,
  SessionPageRequest,
} from "@deepseek-ai/dsh-api-session-controller";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { test } from "vitest";

import {
  apply,
  compactHistoryResponse,
  estimateHistoryResponseBytes,
  inject,
  installSymlinkTraversalGuard,
  maxColdHistoryArtifactBytes,
  maxHistoryResponseBytes,
  predictedHistoryPageSize,
} from "./index.ts";

function inertFileSystem() {
  return {
    lstat: async () => undefined,
    listDir: async () => [],
  };
}

type Request = SessionPageRequest;

const signal = new AbortController().signal;

async function* inertFollow(_request: unknown, _signal: AbortSignal) {
  // No frames are needed by page-only tests.
}

function pageRequest(sessionId: string, maxMessages: number): Request {
  return {
    address: { kind: "session", sessionId: sessionId as never },
    throughSeq: 100,
    maxMessages,
  };
}

async function withEnvironment<T>(
  values: Record<string, string>,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function temporaryArtifact(
  bytes: number,
): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "spark-web-dsh-history-"));
  const path = join(directory, "session.jsonl.zstd");
  await writeFile(path, Buffer.alloc(bytes));
  return {
    path,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

async function temporaryZstdArtifact(
  frames: Buffer[],
): Promise<{ path: string; dispose(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "spark-web-dsh-history-zstd-"));
  const path = join(directory, "session.jsonl.zstd");
  await writeFile(path, Buffer.concat(frames.map((frame) => zstdCompressSync(frame))));
  return {
    path,
    dispose: () => rm(directory, { recursive: true, force: true }),
  };
}

function successfulResponse(_request: Request, text = "ok") {
  return {
    records: [
      {
        type: "event" as const,
        event: { type: "assistant/message", seq: 1, time: 1, data: { text } },
      },
    ],
    hasMore: true,
  };
}

test("spark-web-dsh host half exposes safety policies with the filesystem dependency", () => {
  assert.equal(typeof apply, "function");
  assert.deepEqual(inject, ["fs", "sessionController", "sessionPersistence", "sessions"]);
});

test("filesystem listing stops at directory symlinks instead of following a cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "spark-web-dsh-symlink-"));
  const child = join(directory, "child");
  const loop = join(directory, "loop");
  await mkdir(child);
  await symlink(directory, loop, "dir");

  const fs = {
    async lstat(path: string) {
      const info = await lstat(path);
      const type: "file" | "directory" | "symlink" | "other" = info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other";
      return { type };
    },
    async listDir(target: { displayPath: string; targetKey: string }) {
      const entries = await readdir(target.targetKey, { withFileTypes: true });
      return await Promise.all(
        entries.map(async (entry) => {
          const displayPath = join(target.displayPath, entry.name);
          const targetKey = await realpath(displayPath);
          const info = await stat(targetKey);
          const type: "file" | "directory" | "other" = info.isDirectory()
            ? "directory"
            : info.isFile()
              ? "file"
              : "other";
          return { name: entry.name, type, target: { displayPath, targetKey } };
        }),
      );
    },
  };
  const restore = installSymlinkTraversalGuard(fs);
  const visited: string[] = [];

  async function walk(target: { displayPath: string; targetKey: string }): Promise<void> {
    visited.push(target.displayPath);
    if (visited.length > 10) throw new Error("directory traversal did not terminate");
    const entries = await fs.listDir(target);
    for (const entry of entries) {
      if (entry.type === "directory") await walk(entry.target);
    }
  }

  try {
    await walk({ displayPath: directory, targetKey: await realpath(directory) });
    assert.deepEqual(visited.sort(), [child, directory].sort());
    const rootEntries = await fs.listDir({
      displayPath: directory,
      targetKey: await realpath(directory),
    });
    assert.equal(rootEntries.find((entry) => entry.name === "loop")?.type, "other");
  } finally {
    restore();
    try {
      const restoredEntries = await fs.listDir({ displayPath: loop, targetKey: directory });
      assert.equal(restoredEntries.find((entry) => entry.name === "loop")?.type, "directory");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("history limits accept positive integers and reject invalid values", () => {
  assert.equal(maxColdHistoryArtifactBytes("123"), 123);
  assert.equal(maxHistoryResponseBytes("456"), 456);
  assert.throws(() => maxColdHistoryArtifactBytes("0"), /positive safe integer/);
  assert.throws(() => maxHistoryResponseBytes("1.5"), /positive integer/);
});

test("large artifacts predict one or two messages instead of the requested fifty", () => {
  assert.equal(predictedHistoryPageSize(50, 7 * 1024 * 1024), 2);
  assert.equal(predictedHistoryPageSize(50, 3 * 1024 * 1024), 5);
  assert.equal(predictedHistoryPageSize(50, 1536 * 1024), 10);
  assert.equal(predictedHistoryPageSize(50, 512 * 1024), 50);
  assert.equal(predictedHistoryPageSize(50, undefined), 2);
});

test("bounded JSON estimator matches the actual UTF-8 wire size", () => {
  const value = {
    ascii: 'quote: " slash: \\',
    controls: "line\nnull\0",
    unicode: "历史🙂\ud800",
    array: [true, null, 42],
  };
  assert.equal(estimateHistoryResponseBytes(value), Buffer.byteLength(JSON.stringify(value)));
});

test("history compaction drops cumulative chunks and optional views", () => {
  const response = {
    records: [
      {
        type: "chunks",
        event: {
          type: "chunkrow/assistant",
          seq: 1,
          time: 1,
          data: { chunk: { sparkEvent: { partial: "x".repeat(10_000) } } },
        },
      },
      {
        type: "event",
        event: {
          type: "assistant/message",
          seq: 2,
          time: 2,
          data: { text: "final" },
        },
      },
    ],
    hasMore: true,
  };
  const compacted = compactHistoryResponse(response) as {
    records: Array<{ event: { type: string } }>;
  };
  assert.deepEqual(
    compacted.records.map((entry) => entry.event.type),
    ["assistant/message"],
  );
  assert.ok(estimateHistoryResponseBytes(compacted) < estimateHistoryResponseBytes(response));
});

test.sequential("cold artifacts over the physical fence are refused before history loading", async () => {
  const artifact = await temporaryArtifact(32);
  try {
    await withEnvironment(
      {
        SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES: "16",
        SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES: "1024",
      },
      async () => {
        let calls = 0;
        const ctx = {
          sessionController: {
            page: async (request: Request, _signal: AbortSignal) => {
              calls += 1;
              return successfulResponse(request);
            },
            follow: inertFollow,
          },
          fs: inertFileSystem(),
          sessions: { get: () => undefined },
          sessionPersistence: {
            list: async () => [{ id: "cold" }],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        await assert.rejects(
          ctx.sessionController.page(pageRequest("cold", 50), signal),
          (error: unknown) =>
            error instanceof RemoteError && /too large to open safely/u.test(error.message),
        );
        assert.equal(calls, 0);
      },
    );
  } finally {
    await artifact.dispose();
  }
});

test.sequential("high-compression cold artifacts are refused before history loading", async () => {
  const artifact = await temporaryZstdArtifact([
    Buffer.from("header\n"),
    Buffer.alloc(4_096, 0x61),
    Buffer.alloc(4_096, 0x62),
  ]);
  try {
    await withEnvironment(
      {
        SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES: "5000",
        SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES: "1024",
      },
      async () => {
        let calls = 0;
        const ctx = {
          sessionController: {
            page: async (request: Request, _signal: AbortSignal) => {
              calls += 1;
              return successfulResponse(request);
            },
            follow: inertFollow,
          },
          fs: inertFileSystem(),
          sessions: { get: () => undefined },
          sessionPersistence: {
            list: async () => [{ id: "cold" }],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        await assert.rejects(
          ctx.sessionController.page(pageRequest("cold", 50), signal),
          (error: unknown) => error instanceof RemoteError && /decoded bytes/u.test(error.message),
        );
        assert.equal(calls, 0);
      },
    );
  } finally {
    await artifact.dispose();
  }
});

test.sequential("large live artifacts are preflighted at two messages", async () => {
  const artifact = await temporaryArtifact(12);
  try {
    await withEnvironment(
      {
        SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES: "16",
        SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES: "4096",
      },
      async () => {
        const pageSizes: number[] = [];
        const ctx = {
          sessionController: {
            page: async (request: Request, _signal: AbortSignal) => {
              pageSizes.push(request.maxMessages ?? 50);
              return successfulResponse(request);
            },
            follow: inertFollow,
          },
          fs: inertFileSystem(),
          sessions: { get: () => ({ header: { id: "live" } }) },
          sessionPersistence: {
            list: async () => [],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        const response = await ctx.sessionController.page(pageRequest("live", 50), signal);
        assert.equal(response.hasMore, true);
        assert.deepEqual(pageSizes, [2]);
      },
    );
  } finally {
    await artifact.dispose();
  }
});

test.sequential("oversized prepared pages back off until the response fits", async () => {
  const artifact = await temporaryArtifact(1);
  try {
    await withEnvironment(
      {
        SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES: "1024",
        SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES: "500",
      },
      async () => {
        const pageSizes: number[] = [];
        const ctx = {
          sessionController: {
            page: async (request: Request, _signal: AbortSignal) => {
              const pageSize = request.maxMessages ?? 50;
              pageSizes.push(pageSize);
              return successfulResponse(request, "x".repeat(pageSize * 100));
            },
            follow: inertFollow,
          },
          fs: inertFileSystem(),
          sessions: { get: () => ({ header: { id: "live" } }) },
          sessionPersistence: {
            list: async () => [],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        const response = await ctx.sessionController.page(pageRequest("live", 10), signal);
        assert.equal(response.hasMore, true);
        assert.deepEqual(pageSizes, [10, 5, 2]);
      },
    );
  } finally {
    await artifact.dispose();
  }
});

test.sequential("follow retries its opening snapshot and bounds later frames", async () => {
  const artifact = await temporaryArtifact(1);
  try {
    await withEnvironment(
      {
        SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES: "1024",
        SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES: "500",
      },
      async () => {
        const pageSizes: number[] = [];
        const ctx = {
          sessionController: {
            page: async (request: Request, _signal: AbortSignal) => successfulResponse(request),
            follow: async function* (
              request: SessionFollowRequest,
              _signal: AbortSignal,
            ): AsyncIterable<SessionFollowFrame> {
              const pageSize = request.maxMessages ?? 50;
              pageSizes.push(pageSize);
              yield {
                type: "snapshot" as const,
                header: { id: "live", version: 4 },
                cursor: 1,
                records: successfulResponse(
                  pageRequest("live", pageSize),
                  "x".repeat(pageSize * 100),
                ).records,
                hasMore: true,
                projections: {},
              } as unknown as SessionFollowFrame;
              yield {
                type: "event" as const,
                event: {
                  type: "assistant/message",
                  seq: 2,
                  time: 2,
                  data: { text: "live" },
                },
              };
            },
          },
          fs: inertFileSystem(),
          sessions: { get: () => ({ header: { id: "live" } }) },
          sessionPersistence: {
            list: async () => [],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        const frames = [];
        for await (const frame of ctx.sessionController.follow(
          { address: pageRequest("live", 10).address, maxMessages: 10 },
          signal,
        )) {
          frames.push(frame);
        }
        assert.deepEqual(pageSizes, [10, 5, 2]);
        assert.deepEqual(
          frames.map((frame) => frame.type),
          ["snapshot", "event"],
        );
        assert.ok(frames.every((frame) => estimateHistoryResponseBytes(frame) <= 500));
      },
    );
  } finally {
    await artifact.dispose();
  }
});

test.sequential("a huge final message is returned as a marked preview instead of an error", async () => {
  const artifact = await temporaryArtifact(1);
  try {
    await withEnvironment(
      {
        SPARK_WEB_MAX_COLD_HISTORY_ARTIFACT_BYTES: "1024",
        SPARK_WEB_MAX_HISTORY_RESPONSE_BYTES: "10000",
      },
      async () => {
        const ctx = {
          sessionController: {
            page: async (request: Request, _signal: AbortSignal) =>
              successfulResponse(request, "x".repeat(50_000)),
            follow: inertFollow,
          },
          fs: inertFileSystem(),
          sessions: { get: () => ({ header: { id: "live" } }) },
          sessionPersistence: {
            list: async () => [],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        const response = (await ctx.sessionController.page(pageRequest("live", 1), signal)) as {
          records: Array<{ event: { data: { text: string } } }>;
        };
        assert.match(response.records[0]!.event.data.text, /truncated by Spark Web/);
        assert.ok(estimateHistoryResponseBytes(response) <= 10_000);
      },
    );
  } finally {
    await artifact.dispose();
  }
});
