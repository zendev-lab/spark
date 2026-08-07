import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SparkMemoryStatusSummary } from "@zendev-lab/spark-memory";
import { describe, expect, it, vi } from "vitest";

import { createSparkMcpServer, type SparkMemoryReadStore } from "./index.ts";

const status: SparkMemoryStatusSummary = {
  storePath: "/canonical-owner/memory.json",
  total: 0,
  active: 0,
  forgotten: 0,
  merged: 0,
  superseded: 0,
  quarantined: 0,
  byCategory: {
    failure: 0,
    correction: 0,
    insight: 0,
    preference: 0,
    convention: 0,
    "tool-quirk": 0,
  },
};

describe("spark-mcp canonical-owner boundary", () => {
  it("exercises every handler through mocked owner APIs without opening MCP durable state", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "spark-mcp-no-state-"));
    const originalCwd = process.cwd();
    const originalSparkHome = process.env.SPARK_HOME;
    const list = vi.fn<SparkMemoryReadStore["list"]>(async () => []);
    const ownerStatus = vi.fn<SparkMemoryReadStore["status"]>(async () => status);
    const store: SparkMemoryReadStore = {
      filePath: status.storePath,
      list,
      status: ownerStatus,
    };
    const server = createSparkMcpServer({ store });
    const client = new Client({ name: "spark-mcp-boundary-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      process.chdir(stateRoot);
      process.env.SPARK_HOME = join(stateRoot, "spark-home");
      await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
      expect(client.getServerVersion()).toMatchObject({ name: "spark-mcp" });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "spark_memory_list",
        "spark_memory_status",
      ]);

      const statusResult = await client.callTool({ name: "spark_memory_status", arguments: {} });
      const listResult = await client.callTool({
        name: "spark_memory_list",
        arguments: { includeForgotten: true, limit: 1 },
      });

      expect(statusResult.isError).toBeFalsy();
      expect(listResult.isError).toBeFalsy();
      expect(ownerStatus).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledWith({ includeForgotten: true });
      expect(await readdir(stateRoot)).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      if (originalSparkHome === undefined) delete process.env.SPARK_HOME;
      else process.env.SPARK_HOME = originalSparkHome;
      await Promise.allSettled([client.close(), server.close()]);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
