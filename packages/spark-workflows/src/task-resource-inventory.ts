import { execFile as execFileCallback } from "node:child_process";
import { hostname } from "node:os";
import { promisify } from "node:util";

import type { TaskGpuResource, TaskResourceInventory } from "@zendev-lab/spark-core";

const execFile = promisify(execFileCallback);
export const SPARK_TASK_RESOURCE_INVENTORY_ENV = "SPARK_TASK_RESOURCE_INVENTORY";

export async function discoverTaskResourceInventory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<TaskResourceInventory> {
  const configured = env[SPARK_TASK_RESOURCE_INVENTORY_ENV]?.trim();
  if (configured) return parseTaskResourceInventory(JSON.parse(configured));

  const visible = env.CUDA_VISIBLE_DEVICES?.trim();
  if (visible && visible !== "-1") {
    return {
      nodeId: env.SPARK_NODE_ID?.trim() || hostname(),
      gpus: visible
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
        .map((id) => ({ id, topologyClasses: [] })),
    };
  }

  try {
    const { stdout } = await execFile(
      "nvidia-smi",
      ["--query-gpu=index,memory.total", "--format=csv,noheader,nounits"],
      { env, timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    return {
      nodeId: env.SPARK_NODE_ID?.trim() || hostname(),
      gpus: stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, memoryMiB] = line.split(",").map((part) => part.trim());
          return {
            id: id!,
            ...(Number.isFinite(Number(memoryMiB)) ? { memoryGiB: Number(memoryMiB) / 1024 } : {}),
            topologyClasses: [],
          };
        }),
    };
  } catch {
    return { nodeId: env.SPARK_NODE_ID?.trim() || hostname(), gpus: [] };
  }
}

export function parseTaskResourceInventory(value: unknown): TaskResourceInventory {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Task resource inventory must be an object.");
  }
  const record = value as Record<string, unknown>;
  const nodeId = requireNonEmptyString(record.nodeId, "Task resource inventory nodeId");
  if (!Array.isArray(record.gpus))
    throw new Error("Task resource inventory gpus must be an array.");
  const seen = new Set<string>();
  const gpus: TaskGpuResource[] = record.gpus.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Task resource inventory gpus[${index}] must be an object.`);
    }
    const gpu = entry as Record<string, unknown>;
    const id = requireNonEmptyString(gpu.id, `Task resource inventory gpus[${index}].id`);
    if (seen.has(id)) throw new Error(`Task resource inventory contains duplicate GPU id ${id}.`);
    seen.add(id);
    const memoryGiB =
      typeof gpu.memoryGiB === "number" && Number.isFinite(gpu.memoryGiB) && gpu.memoryGiB > 0
        ? gpu.memoryGiB
        : undefined;
    if (
      gpu.topologyClasses !== undefined &&
      (!Array.isArray(gpu.topologyClasses) ||
        gpu.topologyClasses.some((item) => typeof item !== "string" || !item.trim()))
    ) {
      throw new Error(
        `Task resource inventory gpus[${index}].topologyClasses must be non-empty strings.`,
      );
    }
    return {
      id,
      ...(memoryGiB !== undefined ? { memoryGiB } : {}),
      topologyClasses: [
        ...new Set((gpu.topologyClasses as string[] | undefined)?.map((item) => item.trim()) ?? []),
      ],
    };
  });
  return { nodeId, gpus };
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value.trim();
}
