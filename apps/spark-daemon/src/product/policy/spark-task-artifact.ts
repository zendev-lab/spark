import { defaultArtifactStore, type ArtifactRef } from "@zendev-lab/spark-artifacts";
import { defaultTaskGraphStore, type SparkTaskActionHandler } from "@zendev-lab/spark-tasks";
import type { ProjectRef } from "@zendev-lab/spark-invocation";
import { type Project } from "@zendev-lab/spark-tasks";
import { type Task } from "@zendev-lab/spark-tasks";
import { sparkStateCwd } from "./session-state.ts";

export function createTaskArtifactHandler(
  action: "artifact_link" | "artifact_unlink",
): SparkTaskActionHandler {
  return async ({ params, ctx }) => {
    const cwd = requireCwd(ctx);
    const stateCwd = sparkStateCwd(cwd, ctx);
    const artifactRef = await resolveArtifactRef(stateCwd, params.artifactRef);
    const store = defaultTaskGraphStore(stateCwd, ctx);
    const result = await store.update((graph) => {
      const projectRef = resolveProjectRef(
        graph.projects(),
        optionalString(params.projectRef ?? params.project),
      );
      const task = resolveTask(
        graph.tasks(),
        requiredString(params.taskRef ?? params.task, "task"),
        projectRef,
      );
      const wasLinked = task.artifactRefs.includes(artifactRef);
      const updated =
        action === "artifact_link"
          ? graph.linkTaskArtifact(task.ref, artifactRef)
          : graph.unlinkTaskArtifact(task.ref, artifactRef);
      return {
        task: updated,
        changed: action === "artifact_link" ? !wasLinked : wasLinked,
      };
    });
    const { task, changed } = result.result;
    return {
      content: [
        {
          type: "text",
          text: `${action === "artifact_link" ? "Linked" : "Unlinked"} ${artifactRef} ${action === "artifact_link" ? "to" : "from"} @${task.name}`,
        },
      ],
      details: {
        tool: "task_write",
        action,
        changed,
        refs: { taskRef: task.ref, artifactRef },
        task: {
          ref: task.ref,
          name: task.name,
          artifactRefs: task.artifactRefs,
          updatedAt: task.updatedAt,
        },
      },
    };
  };
}

async function resolveArtifactRef(cwd: string, value: unknown): Promise<ArtifactRef> {
  const requested = requiredString(value, "artifactRef");
  if (!requested.startsWith("artifact:")) {
    throw new Error("artifactRef must be an artifact: ref");
  }
  const store = defaultArtifactStore(cwd);
  const exact = await store.tryGet(requested as ArtifactRef);
  if (exact) return exact.ref;
  const matches = (await store.list()).filter((artifact) => artifact.ref.startsWith(requested));
  if (matches.length === 0) throw new Error(`artifact not found: ${requested}`);
  if (matches.length > 1) {
    throw new Error(`artifactRef is ambiguous: ${requested} matches ${matches.length} artifacts`);
  }
  return matches[0]!.ref;
}

function resolveTask(tasks: Task[], selector: string, projectRef?: ProjectRef): Task {
  const needle = selector.startsWith("@") ? selector.slice(1) : selector;
  const matches = tasks.filter(
    (task) =>
      (!projectRef || task.projectRef === projectRef) &&
      (task.ref === selector ||
        task.ref === needle ||
        task.name === needle ||
        task.title === selector ||
        task.title === needle),
  );
  if (matches.length === 0) throw new Error(`task not found: ${selector}`);
  if (matches.length > 1) throw new Error(`task selector is ambiguous: ${selector}`);
  return matches[0]!;
}

function resolveProjectRef(
  projects: Project[],
  selector: string | undefined,
): ProjectRef | undefined {
  if (!selector) return undefined;
  const matches = projects.filter(
    (project) =>
      project.ref === selector || project.title === selector || project.title.startsWith(selector),
  );
  if (matches.length === 0) throw new Error(`project not found: ${selector}`);
  if (matches.length > 1) throw new Error(`project selector is ambiguous: ${selector}`);
  return matches[0]!.ref;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, "project");
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function requireCwd(ctx: { cwd?: string } | undefined): string {
  if (typeof ctx?.cwd !== "string" || !ctx.cwd.trim()) {
    throw new Error("task_write artifact mutation requires ctx.cwd");
  }
  return ctx.cwd;
}
