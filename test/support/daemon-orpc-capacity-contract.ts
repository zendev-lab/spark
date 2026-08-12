export interface DaemonInvocationCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** Hard control-plane gates while 50 real AgentLoops occupy every root slot. */
export const DAEMON_ORPC_CAPACITY_MAX_EVENT_LOOP_GAP_MS = 100;
export const DAEMON_ORPC_CAPACITY_MAX_RPC_MS = 500;
export const DAEMON_ORPC_CAPACITY_MIN_STREAM_SAMPLES = 20;
export const DAEMON_ORPC_CAPACITY_CONCURRENCY = 50;
export const DAEMON_ORPC_CAPACITY_SESSION_COUNT = 50;

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

export interface DaemonOrpcCapacityProbePhase {
  persistent: DaemonOrpcCapacityProbe;
  fresh: DaemonOrpcCapacityProbe;
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
  model: {
    ref: string;
    default: boolean;
    scoped: boolean;
    available: boolean;
    providerAuthKind: string;
    providerAuthConfigured: boolean;
    diagnostics: string[];
  };
  loadedCounts: DaemonInvocationCounts;
  loadedTurnStatuses: Record<string, string>;
  terminalCounts: DaemonInvocationCounts;
  terminalTurnStatuses: Record<string, string>;
  provider: {
    expectedRequests: number;
    calls: number;
    entered: number;
    completed: number;
    maxInFlight: number;
    uniqueRequestCount: number;
    chunkCount: number;
    tickMs: number;
    emittedTextDeltas: number;
    streamWindowMs: number;
  };
  probes: {
    held: DaemonOrpcCapacityProbePhase;
    streaming: DaemonOrpcCapacityProbePhase;
  };
  eventLoop: {
    intervalMs: number;
    sampleCount: number;
    p95GapMs: number;
    maxGapMs: number;
    /** Milliseconds after the loaded streaming probe began. */
    maxGapAtMs: number;
  };
  rssBytes: {
    before: number;
    peak: number;
    after: number;
  };
  persistence: {
    invocations: number;
    attempts: number;
    succeededAttempts: number;
    attemptEventOutputs: number;
    lifecycleEvents: number;
    invocationEvents: number;
    streamingSnapshots: number;
    streamingSnapshotUpperBound: number;
    terminalAssistantMessages: number;
    exactFinalResults: number;
    monotonicEventSequences: boolean;
  };
}

export interface DaemonOrpcCapacityReport {
  version: 2;
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
  scenario: DaemonOrpcCapacityScenario;
}
