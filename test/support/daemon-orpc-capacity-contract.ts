export interface DaemonInvocationCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** Minimum diagnostic sample count while all five configured root slots are occupied. */
export const DAEMON_ORPC_CAPACITY_MIN_FIVE_WAY_SAMPLES = 20;

export interface DaemonOrpcLatencySummary {
  requestCount: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface DaemonOrpcCapacityProbe {
  rounds: number;
  failures: number;
  daemonStatus: DaemonOrpcLatencySummary;
  turnStatus: DaemonOrpcLatencySummary;
}

export interface DaemonOrpcAdmissionTransition {
  releasedInvocationId: string;
  admittedInvocationId: string;
  counts: DaemonInvocationCounts;
}

export interface DaemonOrpcCapacityScenario {
  configuredConcurrency: number;
  effectiveConcurrency: number;
  /** Base source commit exposed by daemon.status; dirty source is reported separately. */
  statusBuildFingerprint: string;
  cardinality: {
    workspaces: number;
    sessions: number;
    turns: number;
  };
  initialCounts: DaemonInvocationCounts;
  initialTurnStatuses: Record<string, string>;
  transitions: DaemonOrpcAdmissionTransition[];
  maxInFlight: number;
  startedInvocationIds: string[];
  terminalCounts: DaemonInvocationCounts;
  terminalTurnStatuses: Record<string, string>;
  probes: {
    persistent: DaemonOrpcCapacityProbe;
    fresh: DaemonOrpcCapacityProbe;
    heldAtConfiguredLimit: boolean;
  };
  eventLoop: {
    intervalMs: number;
    sampleCount: number;
    p95GapMs: number;
    maxGapMs: number;
  };
  rssBytes: {
    before: number;
    peak: number;
    after: number;
  };
}

export interface DaemonOrpcCapacityReport {
  version: 1;
  environment: {
    platform: NodeJS.Platform;
    arch: string;
    node: string;
    sourceCommit: string;
    sourceTreeDirty: boolean;
    runner: "tsx-source";
  };
  transport: {
    kind: "direct-orpc";
    clientFactory: "createSparkDaemonOrpcClient";
    legacyFallback: false;
    rpcTimeoutMs: number;
  };
  scenarios: DaemonOrpcCapacityScenario[];
}
