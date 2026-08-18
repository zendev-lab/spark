export interface DaemonInvocationCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** Production-shaped cardinality while 50 real AgentLoops occupy every root slot. */
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
    /** Process CPU time accrued during the timer interval containing maxGapMs. */
    maxGapProcessCpuMs: number;
    /** maxGapProcessCpuMs / the actual timer interval containing maxGapMs. */
    maxGapProcessCpuToWallRatio: number;
    /** Main Node thread CPU time accrued during the timer interval containing maxGapMs. */
    maxGapThreadCpuMs: number;
    /** maxGapThreadCpuMs / the actual timer interval containing maxGapMs. */
    maxGapThreadCpuToWallRatio: number;
    /** Process-wide OS-reported involuntary context switches during the max-gap interval. */
    maxGapInvoluntaryContextSwitchesDelta: number;
  };
  hostScheduling: {
    /** Wall-clock duration covered by the event-loop probe. */
    observedWallMs: number;
    processCpuUserMsDelta: number;
    processCpuSystemMsDelta: number;
    /** processCpuUserMsDelta + processCpuSystemMsDelta. */
    processCpuTotalMsDelta: number;
    /** processCpuTotalMsDelta / observedWallMs; may exceed 1 with concurrent native work. */
    observedProcessCpuToWallRatio: number;
    /** OS-reported involuntary context-switch count accrued during observedWallMs. */
    involuntaryContextSwitchesDelta: number;
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
    receiptContextEvents: number;
    invocationEvents: number;
    streamingSnapshots: number;
    streamingSnapshotUpperBound: number;
    terminalAssistantMessages: number;
    exactFinalResults: number;
    monotonicEventSequences: boolean;
  };
}

export interface DaemonOrpcCapacityReport {
  version: 3;
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
