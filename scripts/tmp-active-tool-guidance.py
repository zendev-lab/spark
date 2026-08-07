from pathlib import Path
import re


def edit(path: str, pairs):
    p = Path(path)
    text = p.read_text()
    old = text
    for a, b in pairs:
        text = text.replace(a, b)
    if text != old:
        p.write_text(text)

# Prompt manifest hashes guidance without retaining raw prompt text.
p = Path('packages/spark-turn/src/prompt-manifest.ts')
text = p.read_text()
text = text.replace('SPARK_PROMPT_MANIFEST_VERSION = 3', 'SPARK_PROMPT_MANIFEST_VERSION = 4')
text = text.replace('  modes?: readonly string[];\n}', '  modes?: readonly string[];\n  promptGuidelines?: readonly string[];\n}')
text = text.replace('  modes: string[];\n}', '  modes: string[];\n  guidanceHash?: string;\n}')
text = text.replace(
    '    modes: uniqueLabels(input.modes ?? []),\n  };',
    '    modes: uniqueLabels(input.modes ?? []),\n    ...(guidanceHash(input.promptGuidelines) ? { guidanceHash: guidanceHash(input.promptGuidelines) } : {}),\n  };',
)
insert = '''\nfunction guidanceHash(values: readonly string[] | undefined): string | undefined {\n  const normalized = uniqueLabels(values ?? []);\n  return normalized.length > 0 ? hashText(JSON.stringify(normalized)).slice(0, 16) : undefined;\n}\n'''
text = text.replace('\nfunction normalizeEffect(', insert + '\nfunction normalizeEffect(')
p.write_text(text)

# Native loop: one active registered set owns both tool schemas and tool guidance.
p = Path('packages/spark-turn/src/agent-loop.ts')
text = p.read_text()
if 'from "./active-tool-guidance.ts"' not in text:
    marker = 'import {\n  buildSparkPromptManifest,'
    text = text.replace(marker, 'import { renderActiveToolGuidance } from "./active-tool-guidance.ts";\n' + marker)

text = text.replace(
    '      const baseTurnSystemPrompt = this.systemPrompt;\n      const promptCacheSnapshot = resolveSparkPromptCacheSnapshot({\n        systemPrompt: baseTurnSystemPrompt,',
    '      const activeRegisteredTools = this.collectActiveRegisteredTools();\n      const activeTools = this.collectActiveTools(activeRegisteredTools);\n      const activeToolGuidance = renderActiveToolGuidance(activeRegisteredTools);\n      const baseTurnSystemPrompt = [this.systemPrompt, activeToolGuidance]\n        .filter((section): section is string => Boolean(section))\n        .join("\\n\\n");\n      const promptCacheSnapshot = resolveSparkPromptCacheSnapshot({\n        systemPrompt: baseTurnSystemPrompt,',
)
text = text.replace('      const activeTools = this.collectActiveTools();\n      let emittedEnd = false;', '      let emittedEnd = false;')
text = text.replace(
    '          modes: resolvedRegisteredToolPolicy(tool).modes,\n        })),',
    '          modes: resolvedRegisteredToolPolicy(tool).modes,\n          promptGuidelines: tool.config.promptGuidelines,\n        })),',
)
text = text.replace(
    '  private collectActiveTools(): Tool[] {\n    return this.host\n      .listTools()\n      .filter((entry) => this.isToolAvailable(entry))\n      .map((entry) => toToolDefinition(entry.config));\n  }',
    '  private collectActiveRegisteredTools(): SparkTurnRegisteredTool[] {\n    return this.host.listTools().filter((entry) => this.isToolAvailable(entry));\n  }\n\n  private collectActiveTools(entries: readonly SparkTurnRegisteredTool[]): Tool[] {\n    return entries.map((entry) => toToolDefinition(entry.config));\n  }',
)
p.write_text(text)
