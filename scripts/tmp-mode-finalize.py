from __future__ import annotations

from pathlib import Path
import re


def edit(path: str, pairs: list[tuple[str, str]]) -> None:
    p = Path(path)
    if not p.exists():
        return
    text = p.read_text()
    old = text
    for before, after in pairs:
        text = text.replace(before, after)
    if text != old:
        p.write_text(text)


def regex(path: str, pattern: str, replacement: str, *, count: int = 0) -> None:
    p = Path(path)
    text = p.read_text()
    updated = re.sub(pattern, replacement, text, count=count, flags=re.MULTILINE)
    if updated != text:
        p.write_text(updated)


# Shared role-run Session Mode contract.
edit(
    "packages/spark-core/src/index.ts",
    [
        ('  phase?: "plan" | "implement";\n', '  mode?: "plan" | "execute";\n'),
    ],
)

# Agent loop tests: only Session Mode setters/expectations change.
edit(
    "packages/spark-turn/src/spark-agent-loop.test.ts",
    [
        ('setCurrentMode("implement")', 'setCurrentMode("execute")'),
        ('getCurrentMode(), "implement"', 'getCurrentMode(), "execute"'),
    ],
)

# Mode tool must not pretend mode state owns Project selection.
edit(
    "packages/spark-extension/src/extension/mode/spark-mode-layer.ts",
    [
        ('"execute",\n        "Implement",', '"execute",\n        "Execute",'),
        ('await saveSparkMode(ctx.cwd, ctx, { mode, projectRef: current.projectRef });', 'await saveSparkMode(ctx.cwd, ctx, { mode });'),
    ],
)

# Active prompt composition uses canonical mode end-to-end.
edit(
    "packages/spark-extension/src/extension/spark-active-injection.ts",
    [
        ('const phase = (await loadSparkMode(ctx.cwd, ctx)).phase;', 'const mode = (await loadSparkMode(ctx.cwd, ctx)).mode;'),
        ('renderSparkModeSystemPrompt({ basePrompt, phase, language })', 'renderSparkModeSystemPrompt({ basePrompt, mode, language })'),
        ('phase,\n', 'mode,\n'),
    ],
)
edit(
    "packages/spark-extension/src/__tests__/core.test.ts",
    [
        ('renderSparkActiveSystemPrompt("", "implement")', 'renderSparkActiveSystemPrompt("", "execute")'),
        ('implementPrompt', 'executePrompt'),
    ],
)
edit(
    "packages/spark-extension/src/__tests__/spark-active-injection.test.ts",
    [
        (')).phase', ')).mode'),
    ],
)

# Completion/reconciliation reads Session Mode, not a Phase-shaped state object.
edit(
    "packages/spark-extension/src/extension/spark-agent-end-reconciliation.ts",
    [
        ('const phase = await loadSparkMode(ctx.cwd, ctx);', 'const mode = await loadSparkMode(ctx.cwd, ctx);'),
        ('phase.phase !== "implement"', 'mode.mode !== "execute"'),
    ],
)
edit(
    "packages/spark-extension/src/extension/spark-extension-events.ts",
    [
        ('phase !== "implement"', 'phase !== "execute"'),
    ],
)
edit(
    "packages/spark-extension/src/__tests__/spark-agent-end-reconciliation.test.ts",
    [
        ('sparkActiveMode: { phase: "implement" }', 'sparkActiveMode: { mode: "execute" }'),
        ('{ phase: "implement", projectRef:', '{ mode: "execute", projectRef:'),
        ('{ phase: "plan", projectRef:', '{ mode: "plan", projectRef:'),
        ('ctx.sparkActiveMode = { phase: "plan" }', 'ctx.sparkActiveMode = { mode: "plan" }'),
        (')).phase, "implement"', ')).mode, "execute"'),
    ],
)

# Foreground Goal chooses a Session Mode. TaskKind remains `implement`.
edit(
    "packages/spark-extension/src/extension/spark-foreground-goal-mode.ts",
    [
        ('return "implement";', 'return "execute";'),
        ('task.kind === "execute"', 'task.kind === "implement"'),
    ],
)

# Repro v1-v6 persistence intentionally retains phase/implement. One explicit adapter maps it
# into the canonical Session Mode at the runtime boundary.
p = Path("packages/spark-extension/src/extension/spark-session-repro.ts")
text = p.read_text()
helper = '''\nexport function reproPhaseToSessionMode(phase: SparkSessionPhase): "plan" | "execute" {\n  return phase === "implement" ? "execute" : "plan";\n}\n'''
if "export function reproPhaseToSessionMode" not in text:
    marker = 'export * from "@zendev-lab/spark-repro";\n'
    text = text.replace(marker, marker + helper)
    p.write_text(text)

for path in [
    "packages/spark-extension/src/extension/spark-repro-tool-registration.ts",
    "packages/spark-extension/src/extension/spark-command-registration.ts",
]:
    edit(path, [
        ('sparkActiveMode(repro.currentPhase)', 'sparkActiveMode(reproPhaseToSessionMode(repro.currentPhase))'),
        ('sparkActiveMode(previousRepro.currentPhase)', 'sparkActiveMode(reproPhaseToSessionMode(previousRepro.currentPhase))'),
        ('sparkActiveMode(phaseAdvanced.currentPhase)', 'sparkActiveMode(reproPhaseToSessionMode(phaseAdvanced.currentPhase))'),
        ('sparkActiveMode(stageAdvanced.currentPhase)', 'sparkActiveMode(reproPhaseToSessionMode(stageAdvanced.currentPhase))'),
    ])
    p = Path(path)
    text = p.read_text()
    if "reproPhaseToSessionMode" in text and 'from "./spark-session-repro.ts"' in text:
        # Add to an existing multiline import when it is not already imported.
        if not re.search(r'import\s*\{[^}]*\breproPhaseToSessionMode\b[^}]*\}\s*from "\.\/spark-session-repro\.ts"', text, re.S):
            text = text.replace(
                'from "./spark-session-repro.ts";',
                'from "./spark-session-repro.ts";',
            )
            # Find the nearest import block from spark-session-repro and inject after `{`.
            text = re.sub(
                r'import \{\n([^}]*?)\} from "\.\/spark-session-repro\.ts";',
                lambda m: 'import {\n  reproPhaseToSessionMode,\n' + m.group(1) + '} from "./spark-session-repro.ts";',
                text,
                count=1,
            )
        p.write_text(text)

# Extension root and widget adapters.
edit(
    "packages/spark-extension/src/extension/index.ts",
    [
        ('=== "implement"', '=== "execute"'),
    ],
)
edit(
    "packages/spark-host/src/spark-widget-controller.ts",
    [
        ('Promise<{ phase: "plan" | "execute" }>', 'Promise<{ mode: "plan" | "execute" }>'),
        ('sparkActiveMode: (phase: "plan" | "execute")', 'sparkActiveMode: (mode: "plan" | "execute")'),
        ('const phase = (await deps.loadSparkMode(cwd, ctx)).phase;', 'const mode = (await deps.loadSparkMode(cwd, ctx)).mode;'),
        ('deps.sparkActiveMode(phase)', 'deps.sparkActiveMode(mode)'),
    ],
)
edit(
    "packages/spark-host/src/spark-widget.ts",
    [
        ('◆ Project title · Phase: implement', '◆ Project title · Mode: execute'),
        ('export interface SparkWidgetActiveLens {\n  phase: "plan" | "implement";\n}', 'export interface SparkWidgetActiveLens {\n  mode: "plan" | "execute";\n}'),
        ('activeLens.phase', 'activeLens.mode'),
        ('Phase:', 'Mode:'),
    ],
)

# Session-mode tests: remove the old misnamed project-clearing API and invalid transient fields.
edit(
    "packages/spark-extension/src/__tests__/spark-session-mode.test.ts",
    [
        ('  clearSparkPhase,\n', ''),
        ('{ sparkActiveMode: { mode: "execute" } }', 'undefined'),
        (', focus: "ship"', ''),
        ('.phase', '.mode'),
        ('"implement"', '"execute"'),
    ],
)
# Delete any test whose only subject was the removed clearSparkPhase alias.
p = Path("packages/spark-extension/src/__tests__/spark-session-mode.test.ts")
text = p.read_text()
text = re.sub(
    r'\ntest\("clearSparkPhase[\s\S]*?\n\}\);\n',
    '\n',
    text,
    count=1,
)
p.write_text(text)

# Main extension tests: one context shape caused dozens of cascading errors.
p = Path("packages/spark-extension/src/__tests__/spark-tools.test.ts")
text = p.read_text()
text = text.replace(
    'sparkActiveMode?: {\n    phase: "plan" | "implement";\n  };',
    'sparkActiveMode?: {\n    mode: "plan" | "execute";\n  };',
)
text = text.replace('run.commands.get("implement")', 'run.commands.get("execute")')
text = text.replace('commands.get("implement")', 'commands.get("execute")')
text = text.replace('"missing /implement command"', '"missing /execute command"')
text = text.replace('sparkActiveMode: { phase: "implement" }', 'sparkActiveMode: { mode: "execute" }')
text = text.replace('sparkActiveMode: { phase: "plan" }', 'sparkActiveMode: { mode: "plan" }')
text = text.replace('ctx.sparkActiveMode = { phase: "implement" }', 'ctx.sparkActiveMode = { mode: "execute" }')
text = text.replace('ctx.sparkActiveMode = { phase: "plan" }', 'ctx.sparkActiveMode = { mode: "plan" }')
# Only mode tool invocations use action execute; TaskKind strings are deliberately untouched.
text = text.replace('{ action: "implement" }', '{ action: "execute" }')
p.write_text(text)

# TUI host option is explicitly named sessionMode to avoid colliding with tool scheduling executionMode.
for path in [
    "apps/spark-tui/src/host/contracts.ts",
    "apps/spark-tui/src/host/bootstrap.ts",
    "apps/spark-tui/src/headless-role-executor-core.ts",
    "apps/spark-tui/src/__tests__/spark-headless-role-executor.test.ts",
    "apps/spark-tui/src/__tests__/spark-cli-bootstrap.test.ts",
]:
    edit(path, [
        ('executionPhase', 'sessionMode'),
        ('setPhaseThroughTool', 'setModeThroughTool'),
    ])

edit(
    "apps/spark-tui/src/host/contracts.ts",
    [('sessionMode?: "plan" | "implement";', 'sessionMode?: "plan" | "execute";')],
)
edit(
    "apps/spark-tui/src/headless-role-executor-core.ts",
    [
        ('phase?: "plan" | "execute";', 'mode?: "plan" | "execute";'),
        ('input.phase ?? "implement"', 'input.mode ?? "execute"'),
        ('sessionMode: input.phase', 'sessionMode: input.mode'),
    ],
)
edit(
    "apps/spark-tui/src/host/bootstrap.ts",
    [
        ('input.phase', 'input.mode'),
        ('promptState.phase', 'promptState.mode'),
        ('initialPromptState.phase', 'initialPromptState.mode'),
        ('Promise<{ systemPrompt: string; phase: "plan" | "execute" }>', 'Promise<{ systemPrompt: string; mode: "plan" | "execute" }>'),
        ('const phase = (await loadSparkMode(cwd, ctx)).phase;', 'const mode = (await loadSparkMode(cwd, ctx)).mode;'),
        ('phase,\n', 'mode,\n'),
    ],
)
edit(
    "apps/spark-tui/src/__tests__/spark-cli-bootstrap.test.ts",
    [
        ('"implement"', '"execute"'),
        ('refresh the phase profile', 'refresh the mode profile'),
    ],
)
edit(
    "apps/spark-tui/src/__tests__/spark-headless-role-executor.test.ts",
    [
        ('phase: "implement"', 'mode: "execute"'),
        ('"implement" | "plan"', '"execute" | "plan"'),
        ('"plan" | "implement"', '"plan" | "execute"'),
    ],
)

# Extension role-run callers now use `mode`.
for p in [Path("packages/spark-roles/src/skill-extension.ts"), *Path("packages").rglob("*.ts"), *Path("apps").rglob("*.ts")]:
    if not p.is_file():
        continue
    try:
        text = p.read_text()
    except UnicodeDecodeError:
        continue
    if "ExtensionRoleRunRequest" not in text and "runRole({" not in text and "phase:" not in text:
        continue
    old = text
    # Exact request field contexts; do not touch Repro or restart checkpoint objects.
    text = re.sub(r'(timeoutMs:\s*[^,]+,\n\s*)phase:\s*"implement",', r'\1mode: "execute",', text)
    text = re.sub(r'(timeoutMs:\s*[^,]+,\n\s*)phase:\s*"plan",', r'\1mode: "plan",', text)
    if text != old:
        p.write_text(text)
