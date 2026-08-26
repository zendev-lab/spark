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

interface Request {
  rpcId: unknown;
  payload: {
    sessionId: string;
    beforeSeq?: number;
    maxMessages?: number;
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

function successfulResponse(request: Request, text = "ok"): unknown {
  return {
    rpcId: request.rpcId,
    result: {
      ok: true,
      value: {
        events: [{ event: { type: "assistant/message", seq: 1, data: { text } } }],
        hasMore: true,
      },
    },
  };
}

test("spark-web-dsh host half exposes safety policies with the filesystem dependency", () => {
  assert.equal(typeof apply, "function");
  assert.deepEqual(inject, ["apiProxy", "fs", "sessionPersistence", "sessions"]);
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
    rpcId: "rpc",
    result: {
      ok: true,
      value: {
        events: [
          {
            event: {
              type: "assistant/chunk",
              seq: 1,
              data: { chunk: { sparkEvent: { partial: "x".repeat(10_000) } } },
            },
          },
          {
            event: { type: "assistant/message", seq: 2, data: { text: "final" } },
            view: { duplicated: "x".repeat(10_000) },
          },
        ],
        hasMore: true,
      },
    },
  };
  const compacted = compactHistoryResponse(response) as {
    result: { value: { events: Array<{ event: { type: string }; view?: unknown }> } };
  };
  assert.deepEqual(
    compacted.result.value.events.map((entry) => entry.event.type),
    ["assistant/message"],
  );
  assert.equal(compacted.result.value.events[0]?.view, undefined);
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
          apiProxy: {
            sessions: {
              history: async (request: Request) => {
                calls += 1;
                return successfulResponse(request);
              },
            },
          },
          fs: inertFileSystem(),
          sessions: { get: () => undefined },
          sessionPersistence: {
            list: async () => [{ id: "cold" }],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        const response = (await ctx.apiProxy.sessions.history({
          rpcId: "rpc",
          payload: { sessionId: "cold", maxMessages: 50 },
        })) as { result: { ok: boolean; error: { message: string } } };
        assert.equal(response.result.ok, false);
        assert.match(response.result.error.message, /too large to open safely/);
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
          apiProxy: {
            sessions: {
              history: async (request: Request) => {
                calls += 1;
                return successfulResponse(request);
              },
            },
          },
          fs: inertFileSystem(),
          sessions: { get: () => undefined },
          sessionPersistence: {
            list: async () => [{ id: "cold" }],
            locate: () => ({ path: artifact.path }),
          },
        };
        apply(ctx);
        const response = (await ctx.apiProxy.sessions.history({
          rpcId: "rpc",
          payload: { sessionId: "cold", maxMessages: 50 },
        })) as { result: { ok: boolean; error: { message: string } } };
        assert.equal(response.result.ok, false);
        assert.match(response.result.error.message, /decoded bytes/);
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
          apiProxy: {
            sessions: {
              history: async (request: Request) => {
                pageSizes.push(request.payload.maxMessages ?? 50);
                return successfulResponse(request);
              },
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
        const response = (await ctx.apiProxy.sessions.history({
          rpcId: "rpc",
          payload: { sessionId: "live", maxMessages: 50 },
        })) as { result: { ok: boolean } };
        assert.equal(response.result.ok, true);
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
          apiProxy: {
            sessions: {
              history: async (request: Request) => {
                const pageSize = request.payload.maxMessages ?? 50;
                pageSizes.push(pageSize);
                return successfulResponse(request, "x".repeat(pageSize * 100));
              },
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
        const response = (await ctx.apiProxy.sessions.history({
          rpcId: "rpc",
          payload: { sessionId: "live", maxMessages: 10 },
        })) as { result: { ok: boolean } };
        assert.equal(response.result.ok, true);
        assert.deepEqual(pageSizes, [10, 5, 2]);
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
          apiProxy: {
            sessions: {
              history: async (request: Request) => successfulResponse(request, "x".repeat(50_000)),
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
        const response = (await ctx.apiProxy.sessions.history({
          rpcId: "rpc",
          payload: { sessionId: "live", maxMessages: 1 },
        })) as {
          result: {
            ok: boolean;
            value: { events: Array<{ event: { data: { text: string } } }> };
          };
        };
        assert.equal(response.result.ok, true);
        assert.match(response.result.value.events[0]!.event.data.text, /truncated by Spark Web/);
        assert.ok(estimateHistoryResponseBytes(response) <= 10_000);
      },
    );
  } finally {
    await artifact.dispose();
  }
});
