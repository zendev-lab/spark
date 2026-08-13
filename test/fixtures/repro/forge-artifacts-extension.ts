import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { defaultGitCommandRunner, type GitCommandRunner } from "@zendev-lab/spark-artifacts";
import {
  registerArtifactTool,
  registerEvidenceTool,
  registerGitLifecycleTool,
} from "@zendev-lab/spark-artifacts/extension";
import type { SparkHostAPI, ToolConfig } from "@zendev-lab/spark-core";

const forgeShim = fileURLToPath(new URL("./forge-shim.mjs", import.meta.url));

const forgeRunner: GitCommandRunner = async (command, args, cwd, options) => {
  if (command === "git") return await defaultGitCommandRunner(command, args, cwd);
  if (command === "gh") {
    await options?.beforeHardenedWrite?.();
    return await spawnCollect(process.execPath, [forgeShim, ...args], cwd);
  }
  return { stdout: "", stderr: `unsupported command: ${command}`, code: 127 };
};

export default function forgeArtifactsExtension(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("forge artifacts extension requires registerTool support");
  const api = {
    registerTool(config: ToolConfig) {
      pi.registerTool?.(config);
    },
  };
  registerEvidenceTool(api);
  registerArtifactTool(api);
  registerGitLifecycleTool(api, { runner: forgeRunner });
}

function spawnCollect(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({ stdout, stderr: error.message, code: 127 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}
