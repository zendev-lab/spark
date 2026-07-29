export interface ProjectTaskBoardTask {
  runtimeTaskId: string;
  title: string;
  statusGroup: string;
  readyFrontier: boolean;
  outputArtifactIds?: readonly string[];
  inputArtifactIds?: readonly string[];
}

export interface ProjectTaskBoardProductArtifact {
  id: string;
  title: string;
  kind: string;
  format: string;
}

export interface ProjectTaskBoardCard {
  task: ProjectTaskBoardTask;
  productArtifacts: ProjectTaskBoardProductArtifact[];
  assignable: boolean;
}

export interface ProjectTaskBoardColumn {
  id: string;
  label: string;
  cards: ProjectTaskBoardCard[];
}

const columns = [
  { id: "ready", label: "Ready" },
  { id: "running", label: "Claimed" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" },
  { id: "other", label: "Other" },
] as const;

const PRODUCT_ARTIFACT_KINDS = new Set(["issue", "pr", "preview"]);

export function buildProjectTaskBoard(input: {
  tasks: readonly ProjectTaskBoardTask[];
  artifacts: readonly ProjectTaskBoardProductArtifact[];
  canAssign: boolean;
}): ProjectTaskBoardColumn[] {
  const artifactById = new Map(input.artifacts.map((artifact) => [artifact.id, artifact]));
  const grouped = new Map<string, ProjectTaskBoardCard[]>();
  for (const task of input.tasks) {
    const columnId = columns.some((column) => column.id === task.statusGroup)
      ? task.statusGroup
      : "other";
    // Only product artifacts (issue/pr/preview) are user-visible; internal evidence stays off the board.
    const productArtifacts = [...(task.outputArtifactIds ?? []), ...(task.inputArtifactIds ?? [])]
      .flatMap((artifactId) => artifactById.get(artifactId) ?? [])
      .filter((artifact) => PRODUCT_ARTIFACT_KINDS.has(artifact.kind))
      .slice(0, 3);
    const cards = grouped.get(columnId) ?? [];
    cards.push({
      task,
      productArtifacts: productArtifacts,
      assignable: input.canAssign && task.readyFrontier,
    });
    grouped.set(columnId, cards);
  }

  return columns
    .map((column) => ({ ...column, cards: grouped.get(column.id) ?? [] }))
    .filter((column) => column.cards.length > 0 || column.id !== "other");
}
