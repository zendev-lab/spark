/** Isolated DSH root for structural Spark turn tests and scripted-provider fixtures. */
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

export async function createSparkDshTurnTestRuntime(maxParallelToolCalls: number) {
  const ctx = new Context();
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls });
  } catch (error) {
    await ctx.fiber.dispose().catch(() => undefined);
    throw error;
  }
  return { ctx, dispose: () => ctx.fiber.dispose() };
}
