import type { DatabaseSync } from "node:sqlite";

import { SparkSessionMailStore } from "@zendev-lab/spark-session";
import type { SparkPaths } from "@zendev-lab/spark-system";

import type { DaemonChannelIngressRuntime } from "./channels/ingress.ts";
import type {
  SparkDaemonDrainProgress,
  SparkDaemonEventSink,
  SparkDaemonHumanInteractionResponder,
  SparkDaemonTaskExecutor,
  SparkDaemonInvocationRegistry,
} from "./core/index.ts";
import type { SparkDaemonHumanWaitRegistry } from "./core/human-waits.ts";
import type { SparkDaemonConfig } from "./config.ts";
import type { SparkDaemonModelControl } from "./model-control.ts";
import type { DaemonSessionRegistry } from "./session-registry.ts";
import type { CancelSparkInvocationFn, RunSparkCommandFn } from "./spark/bridge.ts";

export interface ServerSocket {
  send(data: string): void;
}

export interface SparkDaemonUplinkControl {
  requestReconfigure(serverUrl?: string): void;
  subscribe(listener: (serverUrl?: string) => void): () => void;
}

export function createSparkDaemonUplinkControl(): SparkDaemonUplinkControl {
  const listeners = new Set<(serverUrl?: string) => void>();
  return {
    requestReconfigure(serverUrl) {
      for (const listener of listeners) listener(serverUrl);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface StartSparkDaemonOptions {
  paths: SparkPaths;
  sparkHome?: string;
  modelControl?: SparkDaemonModelControl;
  sessionRegistry?: DaemonSessionRegistry;
  config: SparkDaemonConfig;
  db: DatabaseSync;
  once?: boolean;
  signal?: AbortSignal;
  drainSignal?: AbortSignal;
  restartSignal?: AbortSignal;
  drainTimeoutMs?: number;
  runSparkCommand?: RunSparkCommandFn;
  cancelSparkInvocation?: CancelSparkInvocationFn;
  executeInvocation?: SparkDaemonTaskExecutor;
  runScheduler?: boolean;
  schedulerPollIntervalMs?: number;
  schedulerConcurrency?: number;
  invocationTimeoutMs?: number;
  serverReconnectDelayMs?: number;
  uplinkControl?: SparkDaemonUplinkControl;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  localEventSink?: SparkDaemonEventSink;
  channelIngress?: DaemonChannelIngressRuntime;
  mailStore?: SparkSessionMailStore;
  notificationReconcileIntervalMs?: number;
  channelDeliveryReconcileIntervalMs?: number;
  /** Testable clock for daemon-owned main task claim reconciliation. */
  taskClaimNow?: () => string;
  taskClaimReconcileIntervalMs?: number;
  onReady?: (runtime: {
    channelIngress: DaemonChannelIngressRuntime | null;
    respondHumanInteraction: SparkDaemonHumanInteractionResponder;
    flushHumanRequestOutbox: () => void;
    processInvocationQueue: () => boolean;
  }) => void | Promise<void>;
  onDrainProgress?: (progress: SparkDaemonDrainProgress) => void;
  onServing?: () => void;
  managePidFile?: boolean;
}

export interface MessageContext {
  paths: SparkPaths;
  config: SparkDaemonConfig;
  db: DatabaseSync;
  runtimeId: string;
  serverUrl?: string;
  sparkHome?: string;
  controlSparkHome?: string;
  runtimeSessionId: string | undefined;
  setRuntimeSessionId(value: string): void;
  ensureHeartbeat(intervalMs: number): void;
  runSparkCommand: RunSparkCommandFn;
  cancelSparkInvocation: CancelSparkInvocationFn;
  invocationRegistry?: SparkDaemonInvocationRegistry;
  humanWaits?: SparkDaemonHumanWaitRegistry;
  modelControl?: SparkDaemonModelControl;
  channelIngress?: DaemonChannelIngressRuntime;
  sessionRegistry?: DaemonSessionRegistry;
  onRuntimeReady?(): void;
  onIngestAck?(ackOf: string): void;
}
