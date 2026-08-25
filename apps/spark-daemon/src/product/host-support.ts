/**
 * Explicit policy surface consumed by Spark-native hosts.
 *
 * Keep host/runtime mechanisms in spark-host. Role registry / reviewer runner
 * live in spark-roles; builtin skills live in spark-host. Remaining exports
 * come from Spark-native policy modules in this package.
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
