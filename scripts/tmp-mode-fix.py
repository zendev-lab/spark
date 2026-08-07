from __future__ import annotations

from pathlib import Path
import re
import subprocess

ROOT = Path('.')
PARENT = 'origin/agent/prompt-operating-model'


def replace(path: str | Path, pairs: list[tuple[str, str]]) -> None:
    p = Path(path)
    if not p.exists() or not p.is_file():
        return
    text = p.read_text()
    old = text
    for before, after in pairs:
        text = text.replace(before, after)
    if text != old:
        p.write_text(text)


def replace_regex(path: str | Path, pattern: str, replacement: str, count: int = 0) -> None:
    p = Path(path)
    if not p.exists():
        return
    text = p.read_text()
    updated = re.sub(pattern, replacement, text, count=count, flags=re.MULTILINE)
    if updated != text:
        p.write_text(updated)


# Repro's v1-v6 phase/implement fields are persisted compatibility contracts.
# Restore the owner and its persistence adapter; Session Mode maps at the boundary.
subprocess.run(
    ['git', 'checkout', PARENT, '--', 'packages/spark-repro', 'packages/spark-extension/src/extension/spark-session-repro.ts'],
    check=True,
)

# Canonical Session Mode API names. These exact symbols only belong to Session mode routing.
for p in ROOT.rglob('*.ts'):
    if '/0.2/' in '/' + p.as_posix():
        continue
    replace(p, [
        ('getCurrentPhase', 'getCurrentMode'),
        ('setCurrentPhase', 'setCurrentMode'),
        ('enterSparkPlanningMode', 'enterSparkPlanMode'),
        ('enterSparkExecutionMode', 'enterSparkExecuteMode'),
        ('renderSparkPlanningModePrompt', 'renderSparkPlanModePrompt'),
        ('renderSparkExecutionModePrompt', 'renderSparkExecuteModePrompt'),
        ('sparkActiveModeMode', 'sparkActiveModeValue'),
        ('SPARK_SESSION_MODE_CYCLE', 'SPARK_SESSION_MODES'),
        ('policy?.phases', 'policy?.modes'),
        ('policy.phases', 'policy.modes'),
    ])

# The loop's internal vocabulary and diagnostics should use Mode consistently.
p = Path('packages/spark-turn/src/agent-loop.ts')
text = p.read_text()
text = text.replace('setCurrentMode(phase: SparkAgentMode | undefined)', 'setCurrentMode(mode: SparkAgentMode | undefined)')
text = text.replace('this.currentMode = phase;', 'this.currentMode = mode;')
text = text.replace('const phases = resolvedRegisteredToolPolicy(tool).modes;', 'const modes = resolvedRegisteredToolPolicy(tool).modes;')
text = text.replace('phases.length === 0 || phases.includes(this.currentMode)', 'modes.length === 0 || modes.includes(this.currentMode)')
text = text.replace('`phase-inactive tool: ${toolName} (current phase=${this.currentMode ?? "none"}; allowed phases=${phases.join(",") || "all"})`', '`mode-inactive tool: ${toolName} (current mode=${this.currentMode ?? "none"}; allowed modes=${modes.join(",") || "all"})`')
p.write_text(text)

# Canonical Session state API. Clearing a mode never meant clearing project selection,
# so remove the misleading clear operation rather than preserving a compatibility alias.
Path('packages/spark-extension/src/extension/session-mode.ts').write_text('''import type { ProjectRef } from "@zendev-lab/spark-core";
import type { SparkSessionContext } from "@zendev-lab/spark-loop";
import {
  loadCurrentProjectState,
  saveCurrentProjectRef,
  saveSessionMode,
  type SparkAgentMode,
} from "./current-project-state.ts";

export type SparkSessionMode = SparkAgentMode;

export interface SparkSessionModeInput {
  mode: SparkSessionMode;
  projectRef?: ProjectRef;
}

export interface SparkSessionModeState {
  mode: SparkSessionMode;
}

export async function loadSparkMode(
  cwd: string,
  ctx?: SparkSessionContext,
): Promise<SparkSessionModeState> {
  const current = await loadCurrentProjectState(cwd, ctx);
  return { mode: current?.mode ?? "plan" };
}

export async function saveSparkMode(
  cwd: string,
  ctx: SparkSessionContext | undefined,
  input: SparkSessionModeInput,
): Promise<SparkSessionModeState> {
  await saveSessionMode(cwd, ctx, input.mode);
  if (input.projectRef) await saveCurrentProjectRef(cwd, ctx, input.projectRef);
  return { mode: input.mode };
}

export const SPARK_SESSION_MODES: readonly SparkSessionMode[] = ["plan", "execute"];

export function nextSparkSessionMode(current: SparkSessionMode): SparkSessionMode {
  return current === "plan" ? "execute" : "plan";
}
''')

replace('packages/spark-extension/src/extension/session-state.ts', [('  clearSparkPhase,\n', ''), ('  clearSparkMode,\n', '')])

Path('packages/spark-extension/src/extension/spark-mode-state.ts').write_text('''export interface SparkActiveModeState {
  mode?: "plan" | "execute";
}

export function sparkActiveModeValue(state: SparkActiveModeState | undefined): "plan" | "execute" {
  return state?.mode === "execute" ? "execute" : "plan";
}

export function sparkActiveMode(mode: "plan" | "execute"): { mode: "plan" | "execute" } {
  return { mode };
}
''')

# Tool context carries the canonical Session Mode, not the persisted Repro legacy spelling.
replace('packages/spark-extension/src/extension/spark-tool-registration.ts', [
    ('mode: "plan" | "implement";', 'mode: "plan" | "execute";'),
])

# Entry routing is entirely Session Mode semantics.
for name in [
    'packages/spark-extension/src/extension/spark-entry-resolution.ts',
    'packages/spark-extension/src/extension/spark-entry-application.ts',
]:
    p = Path(name)
    text = p.read_text()
    text = text.replace('Phase', 'Mode').replace('phase', 'mode')
    p.write_text(text)

# Normalize desired concise API names after the entry-wide rename.
for name in [
    'packages/spark-extension/src/extension/spark-mode-entry.ts',
    'packages/spark-extension/src/extension/mode/index.ts',
    'packages/spark-extension/src/extension/mode/spark-mode-renderers.ts',
]:
    replace(name, [
        ('enterSparkPlanningMode', 'enterSparkPlanMode'),
        ('enterSparkExecutionMode', 'enterSparkExecuteMode'),
        ('renderSparkPlanningModePrompt', 'renderSparkPlanModePrompt'),
        ('renderSparkExecutionModePrompt', 'renderSparkExecuteModePrompt'),
    ])

# Common Session-mode object shapes in host/runtime/test adapters.
SESSION_FILES = [
    'apps/spark-daemon/src/spark/session-run.ts',
    'apps/spark-tui/src/headless-role-executor-core.ts',
    'apps/spark-tui/src/host/agent-loop.ts',
    'apps/spark-tui/src/host/bootstrap.ts',
    'packages/spark-extension/src/extension/spark-active-injection.ts',
    'packages/spark-extension/src/extension/spark-agent-end-reconciliation.ts',
    'packages/spark-extension/src/extension/spark-command-registration.ts',
    'packages/spark-extension/src/extension/spark-extension-events.ts',
    'packages/spark-extension/src/extension/spark-foreground-goal-mode.ts',
    'packages/spark-extension/src/extension/spark-mode-entry.ts',
    'packages/spark-extension/src/extension/spark-widget-controller.ts',
    'packages/spark-extension/src/extension/spark-workflow-loop-entry.ts',
    'packages/spark-host/src/spark-widget-controller.ts',
]
for name in SESSION_FILES:
    replace(name, [
        ('"plan" | "implement"', '"plan" | "execute"'),
        ('"implement" | "plan"', '"execute" | "plan"'),
        ('mode: "implement"', 'mode: "execute"'),
        ('=== "implement"', '=== "execute"'),
        ('=== "execute" ? "implement"', '=== "execute" ? "execute"'),
    ])

# Current command is /execute. No public alias is retained in the current surface.
replace('packages/spark-extension/src/extension/spark-command-registration.ts', [
    ('registerCommand("implement"', 'registerCommand("execute"'),
    ('"implement"', '"execute"'),
])

# Tests/adapters referring to the Session loop API should follow the public rename.
for p in [
    *Path('apps/spark-tui/src/__tests__').glob('*.ts'),
    Path('packages/spark-turn/src/spark-agent-loop.test.ts'),
    Path('packages/spark-extension/src/__tests__/spark-active-injection.test.ts'),
    Path('packages/spark-extension/src/__tests__/spark-agent-end-reconciliation.test.ts'),
    Path('packages/spark-extension/src/__tests__/spark-mode-state.test.ts'),
    Path('packages/spark-extension/src/__tests__/spark-session-mode.test.ts'),
]:
    if not p.exists():
        continue
    replace(p, [
        ('"plan" | "implement"', '"plan" | "execute"'),
        ('"implement" | "plan"', '"execute" | "plan"'),
        ('mode: "implement"', 'mode: "execute"'),
        ('setCurrentPhase', 'setCurrentMode'),
        ('getCurrentPhase', 'getCurrentMode'),
        ('sparkActiveLens', 'sparkActiveMode'),
    ])

# Session-mode tests use mode fields. Preserve explicit legacy persisted {phase:"implement"}
# fixtures in current-project migration tests by limiting this to renamed mode tests.
for name in [
    'packages/spark-extension/src/__tests__/spark-mode-state.test.ts',
    'packages/spark-extension/src/__tests__/spark-session-mode.test.ts',
]:
    p = Path(name)
    if p.exists():
        text = p.read_text().replace('.phase', '.mode').replace(' phase:', ' mode:').replace('{ phase:', '{ mode:')
        text = text.replace('"implement"', '"execute"')
        p.write_text(text)

# Old renamed import paths are Session-mode leftovers, not compatibility contracts.
for p in ROOT.rglob('*.ts'):
    if '/0.2/' in '/' + p.as_posix():
        continue
    replace(p, [
        ('../extension/phase/spark-phase-renderers.ts', '../extension/mode/spark-mode-renderers.ts'),
        ('./phase/spark-phase-renderers.ts', './mode/spark-mode-renderers.ts'),
        ('../extension/spark-phase-entry.ts', '../extension/spark-mode-entry.ts'),
        ('../extension/spark-phase-state.ts', '../extension/spark-mode-state.ts'),
        ('./spark-phase-entry.ts', './spark-mode-entry.ts'),
        ('./spark-phase-state.ts', './spark-mode-state.ts'),
    ])

# Do not keep mechanically duplicated obsolete files after their git-mv replacements.
for obsolete in [
    'packages/spark-extension/src/__tests__/spark-phase-state.test.ts',
    'packages/spark-extension/src/extension/phase',
    'packages/spark-extension/src/extension/session-phase.ts',
    'packages/spark-extension/src/extension/spark-phase-state.ts',
    'packages/spark-phases',
]:
    p = Path(obsolete)
    if p.is_file():
        p.unlink()
    elif p.is_dir():
        import shutil
        shutil.rmtree(p)
