import type { TaskPlanInput } from "@zendev-lab/spark-tasks";

export interface ReproExperimentIssue {
  task: string;
  name?: string;
  itemIndex: number;
  itemId: string;
  field: "command" | "expected";
  message: string;
}

const COMMAND_LABEL = /(?:^|[\s;，。])(command|cmd|script|命令|脚本)\s*[:：]\s*([^;\n，。]*)/giu;
const EXPECTED_LABEL =
  /(?:^|[\s;，。])(?:expected|expect|observable|assert|预期|期望|观测|断言)\s*[:：]\s*([^;\n，。]*)/giu;
const BACKTICK_VALUE = /`([^`\n]+)`/gu;
const COMMON_CLI =
  /^(?:pnpm|npm|npx|yarn|bun|node|tsx|vitest|vite|vp|cargo|go|pytest|ruff|uv|git|curl|make|cmake|docker|kubectl|bash|sh)\s+\S+/iu;
const EXPLICIT_EXECUTABLE_PATH =
  /^(?:\.\.?\/|~\/|\/)(?:[\w.-]+\/)*[\w.-]+\.(?:sh|bash|js|mjs|cjs|ts|tsx|py)(?:\s+.*)?$/iu;
const SCRIPT_DIRECTORY_PATH =
  /^(?:[\w.-]+\/)*(?:scripts?|bin)\/[\w.-]+(?:\.(?:sh|bash|js|mjs|cjs|ts|tsx|py))?(?:\s+.*)?$/iu;
const REPO_EXECUTABLE_PATH =
  /^(?:[\w.-]+\/)+[\w.-]+\.(?:sh|bash|js|mjs|cjs|ts|tsx|py)(?:\s+.*)?$/iu;
const PLACEHOLDER =
  /^(?:tbd|todo|n\/?a|none|placeholder|later|describe\s+what\s+to\s+run|determine(?:d)?\s+later|expected\s+result|observable|result|unknown|待定|稍后确定|补充命令|描述命令)$/iu;
const OBSERVABLE_RESULT =
  /(?:exit\s*(?:code|status)\s*(?:=|:|is|为)?\s*-?\d+|退出码\s*(?:=|:|：|为)?\s*-?\d+|\b\d+\s+(?:tests?|files?|items?|rows?|matches?|errors?|warnings?)\s+(?:passed|failed|matched|found|remain(?:ing)?)\b|(?:count|计数)\s*(?:=|:|：|is|为)\s*\d+|(?:threshold|阈值)\s*(?:=|:|：|is|为|[<>]=?)\s*\d+|(?:output|result|输出|结果)\s+(?:matches?|匹配)\s+\S+)/iu;

export function collectReproExperimentIssues(
  tasks: readonly TaskPlanInput[],
): ReproExperimentIssue[] {
  return tasks.flatMap((task) =>
    (task.plan?.items ?? []).flatMap((item, index) => {
      if (["done", "cancelled", "deleted"].includes(item.status)) return [];
      const text = [item.title, item.description].filter(Boolean).join("\n");
      const identity = {
        task: task.name ? "@" + task.name + ": " + task.title : task.title,
        ...(task.name ? { name: task.name } : {}),
        itemIndex: index,
        itemId: item.id,
      };
      const issues: ReproExperimentIssue[] = [];
      if (!hasConcreteCommand(text)) {
        issues.push({
          ...identity,
          field: "command",
          message: "Active repro experiment item must name an executable command or script.",
        });
      }
      if (!hasConcreteExpected(text)) {
        issues.push({
          ...identity,
          field: "expected",
          message: "Active repro experiment item must state an observable expected result.",
        });
      }
      return issues;
    }),
  );
}

function hasConcreteCommand(text: string): boolean {
  for (const match of text.matchAll(COMMAND_LABEL)) {
    const label = (match[1] ?? "").toLowerCase();
    const allowRepoScript = label === "script" || label === "脚本";
    if (isConcreteCommandValue(match[2] ?? "", allowRepoScript)) return true;
  }
  for (const match of text.matchAll(BACKTICK_VALUE)) {
    if (isConcreteCommandValue(match[1] ?? "")) return true;
  }
  return text
    .split(/[\n;]/u)
    .map((segment) => segment.trim())
    .some((segment) => isConcreteCommandValue(segment));
}

function isConcreteCommandValue(value: string, allowRepoScript = false): boolean {
  const candidate = value.trim();
  if (!candidate || PLACEHOLDER.test(candidate)) return false;
  return (
    COMMON_CLI.test(candidate) ||
    EXPLICIT_EXECUTABLE_PATH.test(candidate) ||
    SCRIPT_DIRECTORY_PATH.test(candidate) ||
    (allowRepoScript && REPO_EXECUTABLE_PATH.test(candidate))
  );
}

function hasConcreteExpected(text: string): boolean {
  if (OBSERVABLE_RESULT.test(text)) return true;
  for (const match of text.matchAll(EXPECTED_LABEL)) {
    const value = (match[1] ?? "").trim();
    if (value && !PLACEHOLDER.test(value) && OBSERVABLE_RESULT.test(value)) return true;
  }
  return false;
}
