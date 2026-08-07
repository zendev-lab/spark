export interface SparkToolOperationalNotes {
  atomic: string;
  idempotent: string;
  prerequisites: string[];
}

const DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES: SparkToolOperationalNotes = {
  atomic: "read-only",
  idempotent: "yes; repeated calls only re-read current Spark state",
  prerequisites: ["Spark state exists in the current workspace."],
};

export function withSparkToolOperationalNotes(toolName: string, description: string): string {
  const notes =
    toolName === "delegation"
      ? {
          atomic: "one typed Hub coordination action; target execution remains daemon-owned",
          idempotent:
            "create is idempotent by key; delivery is idempotent by delegation and message sequence",
          prerequisites: [
            "The caller is a workspace main session or the command is issued by a Hub Owner.",
            "The source and target are different active workspaces in the same Hub.",
          ],
        }
      : DEFAULT_SPARK_TOOL_OPERATIONAL_NOTES;
  return [
    description.trimEnd(),
    "",
    `Atomic: ${notes.atomic}`,
    `Idempotent: ${notes.idempotent}`,
    "Prerequisites:",
    ...notes.prerequisites.map((item) => `- ${item}`),
  ].join("\n");
}
