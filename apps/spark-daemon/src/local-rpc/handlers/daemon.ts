import { open } from "node:fs/promises";
import { join } from "node:path";
import { SPARK_DAEMON_LOG_TOTAL_MAX_BYTES } from "@zendev-lab/spark-protocol";
import { SparkInvocationStore } from "../../store/invocations.ts";
import { SparkChannelDeliveryStore } from "../../store/channel-deliveries.ts";
import { sparkDaemonServerStatusSummaries } from "../../store/workspaces.js";
import { SparkDaemonControlError } from "../../control-error.ts";
import type { LocalRpcDispatchContext } from "./context.ts";
import type { LocalRpcServiceOutput, LocalRpcServiceRequest } from "../types.ts";

type DaemonRequest = Extract<
  LocalRpcServiceRequest,
  { method: "daemon.status" | "daemon.logs" | "daemon.stop" | "daemon.restart" }
>;

export async function handleDaemonRequest(
  ctx: LocalRpcDispatchContext,
  request: DaemonRequest,
): Promise<LocalRpcServiceOutput<DaemonRequest>> {
  const { db, onStop, options } = ctx;
  switch (request.method) {
    case "daemon.status": {
      const store = new SparkInvocationStore(db);
      const oldestActive = store.oldestActive();
      return {
        servers: sparkDaemonServerStatusSummaries(db),
        invocations: store.counts(),
        invocationHealth: {
          ...(oldestActive.queued ? { oldestQueuedAt: oldestActive.queued } : {}),
          ...(oldestActive.running ? { oldestRunningAt: oldestActive.running } : {}),
        },
        ...(options.getExecutionStatus ? { execution: options.getExecutionStatus() } : {}),
        channelDeliveries: new SparkChannelDeliveryStore(db).summary(),
        lifecycle: options.getLifecycle?.() ?? { state: "running" },
        ...(options.getBuildFingerprint ? { buildFingerprint: options.getBuildFingerprint() } : {}),
        observedAt: new Date().toISOString(),
      };
    }
    case "daemon.logs":
      return await readDaemonLogTail(ctx.paths, request.params.lines);
    case "daemon.stop":
      options.onStopRequested?.();
      setTimeout(() => {
        void onStop?.();
      }, 0);
      return {
        stopping: true,
        observedAt: new Date().toISOString(),
      };
    case "daemon.restart": {
      if (!options.onRestart) {
        throw new SparkDaemonControlError(
          "daemon_restart_unavailable",
          "Spark daemon restart control is not available.",
        );
      }
      try {
        return await options.onRestart();
      } catch (error) {
        if (error instanceof SparkDaemonControlError) throw error;
        console.error(
          `[spark-daemon] restart scheduling failed: ${daemonRestartFailureLogDetail(error)}`,
        );
        throw new SparkDaemonControlError(
          "daemon_restart_unavailable",
          "Spark daemon could not arm a safe restart successor. Inspect `spark daemon logs --lines 100`, correct the reported local lifecycle error, and retry.",
        );
      }
    }
  }
}

const daemonLogReadWindowBytes = SPARK_DAEMON_LOG_TOTAL_MAX_BYTES * 4;

async function readDaemonLogTail(paths: LocalRpcDispatchContext["paths"], lineLimit: number) {
  const sources = [
    { name: "service_stdout" as const, path: join(paths.logDir, "service.stdout.log") },
    { name: "service_stderr" as const, path: join(paths.logDir, "service.stderr.log") },
    { name: "daemon_events" as const, path: paths.logFile },
  ];
  let remainingBytes = SPARK_DAEMON_LOG_TOTAL_MAX_BYTES;
  let totalBytes = 0;
  let truncated = false;
  const projected = [];

  for (const source of sources) {
    const tail = await readBoundedLogSource(source.path, lineLimit);
    truncated ||= tail.truncated;
    const lines: string[] = [];
    for (const line of tail.lines.toReversed()) {
      const redacted = redactDaemonLogLine(line);
      const bytes = Buffer.byteLength(`${redacted}\n`, "utf8");
      if (bytes > remainingBytes) {
        truncated = true;
        continue;
      }
      lines.unshift(redacted);
      remainingBytes -= bytes;
      totalBytes += bytes;
    }
    projected.push({ name: source.name, lines });
  }

  return {
    sources: projected,
    totalBytes,
    truncated,
    observedAt: new Date().toISOString(),
  };
}

async function readBoundedLogSource(path: string, lineLimit: number) {
  let file;
  try {
    file = await open(path, "r");
    const stats = await file.stat();
    if (stats.size === 0 || lineLimit === 0) {
      return { lines: [] as string[], truncated: stats.size > 0 && lineLimit === 0 };
    }
    const start = Math.max(0, stats.size - daemonLogReadWindowBytes);
    const buffer = Buffer.alloc(stats.size - start);
    await file.read(buffer, 0, buffer.byteLength, start);
    const content = buffer.toString("utf8");
    const completeContent =
      start > 0 ? content.slice(Math.max(0, content.indexOf("\n") + 1)) : content;
    const allLines = completeContent.endsWith("\n")
      ? completeContent.slice(0, -1).split("\n")
      : completeContent.split("\n");
    return {
      lines: allLines.slice(-lineLimit),
      truncated: start > 0 || allLines.length > lineLimit,
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { lines: [] as string[], truncated: false };
    throw error;
  } finally {
    await file?.close();
  }
}

export function redactDaemonLogLine(line: string): string {
  return line
    .replace(
      /((?:authorization|token|secret|password|api[_-]?key|runtimeToken|refreshToken)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s,"'}]+/giu,
      "$1[redacted]",
    )
    .replace(/Bearer\s+[^\s"']+/giu, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[redacted]")
    .replace(/\bspark_[A-Za-z0-9_-]{12,}\b/gu, "[redacted]")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/giu, "$1[redacted]");
}

function daemonRestartFailureLogDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const knownFailures = [
    ["restart helper IPC is unavailable", "restart helper IPC is unavailable"],
    ["restart helper exited before readiness", "restart helper exited before readiness"],
    ["restart helper was not fully armed", "restart helper did not complete arming"],
    ["restart helper did not receive a process id", "restart helper process did not start"],
    ["restart arming was cancelled", "restart helper arming was cancelled"],
    [
      "restart intent changed while a helper was being armed",
      "restart intent changed during arming",
    ],
    ["restart fence generation mismatch", "restart fence generation mismatch"],
    ["targets a different build", "restart target build changed during arming"],
  ] as const;
  return (
    knownFailures.find(([fragment]) => message.includes(fragment))?.[1] ??
    "internal restart scheduling failure"
  );
}
