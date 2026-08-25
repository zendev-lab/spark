/** Host-neutral tool registration types used by the Cue operation runtime. */

import type { CueClient, CueResolvedTransport, SpawnAdapterHandle } from "../client/cue-client.ts";

export interface CueOperationHost {
  registerTool(config: CueOperationDefinition): void;
}

export type CueNotifyLevel = "info" | "warning" | "error" | "success";

export interface CueOperationContext {
  cwd?: string;
  sessionId?: string;
  env?: Record<string, string | undefined>;
  cueClient?: CueClient;
  /** Internal resolved transport used to keep SSH cwd selection explicit. */
  cueResolvedTransport?: CueResolvedTransport;
  /** Explicit remote cwd; local session paths are never mapped onto SSH hosts. */
  cueRemoteCwd?: string;
  /** Whether an unreachable local daemon may be auto-started. Defaults to true. */
  cueAutoStartLocal?: boolean;
  /** Explicit per-host override for forwarding sensitive environment variables. */
  cueForwardSensitiveEnv?: boolean;
  /** Opaque per-execution launch lease; policy remains owned by the host adapter. */
  cueSpawnAdapter?: SpawnAdapterHandle;
  ui?: { notify?: (msg: string, level: CueNotifyLevel) => void };
}

export interface CueOperationRegistration {
  releaseSession(ctx?: CueOperationContext): void;
  dispose(): void;
}

export interface CueOperationDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: (update: { content: Array<{ type: "text"; text: string }> }) => void,
    ctx: CueOperationContext,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: Record<string, unknown>;
  }>;
}

export function registerCueTool(host: CueOperationHost, config: CueOperationDefinition): void {
  host.registerTool(config);
}
