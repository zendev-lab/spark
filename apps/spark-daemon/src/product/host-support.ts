/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Host/runtime mechanisms live in the daemon product owner. Role registry,
 * reviewer runner, and builtin Skills remain in spark-roles. Remaining exports
 * come from Spark-native policy modules in this directory.
 */

export { renderSparkActiveSystemPrompt } from "./policy/spark-active-injection.ts";
export {
  defaultBuiltinSkillsDir,
  parseSkillFrontmatter,
  renderBaseSystemPromptsCatalogPrompt,
  renderBaseSystemPromptsPrompt,
  renderBuiltinSkillsCatalogForPrompt,
  type SparkSkillFrontmatter,
} from "@zendev-lab/spark-roles/builtin-skills";
export { sparkSessionKey } from "@zendev-lab/spark-driver";
export type { SparkSessionContext } from "@zendev-lab/spark-driver";
export { SparkRolesReviewerRunner, createSparkRoleRegistry } from "@zendev-lab/spark-roles";
