/** Canonical public Skill resolver surface and model-facing routing copy. */

import {
  SparkSkillResolver as BaseSparkSkillResolver,
  type SparkSkill,
  type SparkSkillPromptMatch,
  type SparkSkillResolverOptions,
} from "./skill-resolver.ts";

export {
  defaultBuiltinSkillsDir,
  defaultProjectAgentsSkillsDirs,
  defaultSparkSkillsRoot,
  defaultUserAgentsSkillsDir,
  defaultUserSkillsDir,
  loadMatchingSparkSkillsForPrompt,
  loadSkillsFromDir,
  loadSparkSkillByName,
  matchSparkSkillsForPrompt,
  parseSkillFrontmatter,
  type SparkLoadedSkill,
  type SparkSkill,
  type SparkSkillDiagnostic,
  type SparkSkillFrontmatter,
  type SparkSkillLayer,
  type SparkSkillPromptMatch,
  type SparkSkillResolveResult,
  type SparkSkillResolverOptions,
} from "./skill-resolver.ts";

export class SparkSkillResolver extends BaseSparkSkillResolver {
  constructor(options: SparkSkillResolverOptions) {
    super(options);
  }

  async formatAvailableSkillsForPrompt(): Promise<string> {
    const { skills } = await this.resolve();
    return formatSparkSkillsForPrompt(skills);
  }
}

export function formatSparkSkillsForPrompt(skills: readonly SparkSkill[]): string {
  const visible = modelInvocableSkills(skills);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following Skills provide specialized instructions or intelligent execution for specific tasks.",
    "When one or more Skills match, choose one primary execution path:",
    "- If skill_agent is active, call it once with the complete matching Skill set and a self-contained instruction. The host loads every selected Skill body exactly once for one dedicated owned Agent Session.",
    "- Use read on a listed file only when this session itself must inspect and follow the Skill instructions.",
    "Do not explicitly read selected Skills before calling skill_agent, and do not duplicate work while the dedicated Agent owns it. Resolve relative references against each listed Skill directory.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/**
 * Render request-matched Skill metadata as dynamic routing context. Skill
 * bodies stay unloaded until the parent explicitly reads them or calls the
 * host-owned multi-Skill Agent surface.
 */
export function formatSelectedSparkSkillsForPrompt(
  matches: readonly SparkSkillPromptMatch[],
): string {
  if (matches.length === 0) return "";
  const hasLoadedBodies = matches.some(
    (match) => match.promptBody !== false && match.content.length > 0,
  );
  const lines = [
    "Dynamic context checkpoint: matching Skills for the current user request.",
    hasLoadedBodies
      ? "Some Skill bodies were explicitly loaded by the caller. Follow only those loaded instructions when relevant."
      : "Skill bodies are not loaded. Call skill_agent once with the complete matching Skill set for a self-contained unit of work, or read SKILL.md only when this session itself must follow it.",
    "Do not explicitly read selected Skills before calling skill_agent, and do not duplicate assigned work in this session.",
    "<selected_skills>",
  ];
  for (const match of matches) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(match.skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(match.skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(match.skill.filePath)}</location>`);
    if (match.promptBody !== false && match.content.length > 0) {
      lines.push("    <content>");
      for (const contentLine of match.content.replace(/\r\n?/gu, "\n").split("\n")) {
        lines.push(`      ${contentLine}`);
      }
      lines.push("    </content>");
    } else if (match.content.length > 0) {
      lines.push(`    <title>${escapeXml(match.content)}</title>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</selected_skills>");
  return lines.join("\n");
}

function modelInvocableSkills(skills: readonly SparkSkill[]): SparkSkill[] {
  return skills.filter((skill) => !skill.disabled && !skill.disableModelInvocation);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
