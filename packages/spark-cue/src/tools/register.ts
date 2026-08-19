/** Thin Spark/Pi host adapter for the canonical Cue operation layer. */

import type { SparkHostAPI } from "@zendev-lab/spark-core";
import { registerCueOperationDefinitions } from "../operations/definitions.ts";
import type { SparkCueHostApi, SparkCueToolRegistration } from "./host-types.ts";

export {
  cueShellCommandSyntaxIssue,
  normalizeCueBoolean,
  normalizeCueLimit,
  normalizeCueResourceNeeds,
  normalizeCueStderrForDisplay,
  normalizeCueTailBytes,
  normalizeCueTerminalOutput,
  normalizeCueTimeoutSeconds,
  renderCueChainStatus,
  renderCueScriptResult,
  resolveCueExecTarget,
  resolveCueWorkingDirectory,
  resolvePythonRunner,
} from "../operations/definitions.ts";

export function registerSparkCueTools(pi: SparkCueHostApi): SparkCueToolRegistration {
  return registerCueOperationDefinitions(pi);
}

export default function piCueExtension(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("spark-cue extension requires registerTool support");
  registerSparkCueTools({
    registerTool: (config) => pi.registerTool?.(config),
    on: pi.on
      ? (event, handler) => {
          pi.on?.(event, (payload, ctx) => handler(payload, ctx));
        }
      : undefined,
    getActiveTools: pi.getActiveTools ? () => pi.getActiveTools!() : undefined,
    setActiveTools: pi.setActiveTools ? (names) => pi.setActiveTools!(names) : undefined,
  });
}
