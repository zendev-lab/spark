import type { Context, Plugin } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

import {
  createCueToolRuntime,
  type CueExecutionContext,
  type CueToolArgsMap,
  type CueToolName,
  type CueToolResultMap,
  type CueToolRuntime,
  type CueToolRuntimeConfig,
} from "./operations/index.ts";

export const name = "dsh-cue";

export interface Config {
  autoStartLocal?: boolean;
  remoteCwd?: string;
  forwardSensitiveEnv?: boolean;
}

export const Config = z.object({
  autoStartLocal: z.boolean().default(true),
  remoteCwd: z.string(),
  forwardSensitiveEnv: z.boolean().default(false),
}) as unknown as NonNullable<Plugin.Object<Config>["Config"]>;

declare module "@deepseek-ai/cordis" {
  interface Context {
    cue: CueService;
  }
}

/** Process-local Cue execution service shared by Cordis host adapters. */
export class CueService implements CueToolRuntime {
  readonly runtime: CueToolRuntime;

  constructor(config: CueToolRuntimeConfig = {}) {
    this.runtime = createCueToolRuntime(config);
  }

  execute<Name extends CueToolName>(
    toolName: Name,
    args: CueToolArgsMap[Name],
    context: CueExecutionContext,
  ): Promise<CueToolResultMap[Name]> {
    return this.runtime.execute(toolName, args, context);
  }

  releaseSession(sessionId: string): void {
    this.runtime.releaseSession(sessionId);
  }

  dispose(): void {
    this.runtime.dispose();
  }
}

export function apply(ctx: Context, config: Config = {}): () => void {
  const service = new CueService({
    autoStartLocal: config.autoStartLocal ?? true,
    remoteCwd: config.remoteCwd,
    forwardSensitiveEnv: config.forwardSensitiveEnv ?? false,
  });
  ctx.provide("cue", service);
  return () => service.dispose();
}

export const plugin: Plugin.Object<Config> = { name, Config, apply };
