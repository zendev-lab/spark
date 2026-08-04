import { getCockpitDictionary } from "@zendev-lab/spark-i18n/cockpit";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import ProjectTaskBoard from "./ProjectTaskBoard.svelte";
import { buildProjectTaskBoard } from "./project-task-board";

const messages = getCockpitDictionary("en").taskBoard;

describe("ProjectTaskBoard component contract", () => {
  it("renders board columns, frontier evidence, and an assignable task form", () => {
    const columns = buildProjectTaskBoard({
      canAssign: true,
      tasks: [
        {
          runtimeTaskId: "task:ready",
          title: "Verify the migration",
          statusGroup: "ready",
          readyFrontier: true,
          outputArtifactIds: ["artifact:preview"],
        },
      ],
      artifacts: [
        {
          id: "artifact:preview",
          title: "Migration preview",
          kind: "preview",
          format: "md",
        },
      ],
    });
    const { body } = render(ProjectTaskBoard, {
      props: { columns, workspaceUrl: "/workspace-a", messages },
    });

    expect(body).toContain(messages.aria);
    expect(body).toContain(messages.columns.ready);
    expect(body).toContain("Verify the migration");
    expect(body).toContain("task:ready");
    expect(body).toContain(messages.readyFrontier);
    expect(body).toContain('href="/workspace-a/artifacts/artifact:preview"');
    expect(body).toContain("Migration preview");
    expect(body).toContain('action="?/assignTask"');
    expect(body).toContain('name="runtimeTaskId"');
    expect(body).toContain('value="task:ready"');
    expect(body).toContain(messages.assign);
  });

  it("renders non-assignable tasks with a disabled action and empty columns", () => {
    const columns = buildProjectTaskBoard({
      canAssign: false,
      tasks: [
        {
          runtimeTaskId: "task:running",
          title: "Already claimed",
          statusGroup: "running",
          readyFrontier: false,
        },
      ],
      artifacts: [],
    });
    const { body } = render(ProjectTaskBoard, {
      props: { columns, workspaceUrl: "/workspace-a", messages },
    });

    expect(body).toContain("Already claimed");
    expect(body).toContain(messages.notAssignable);
    expect(body).toContain("disabled");
    expect(body).toContain(messages.empty);
  });
});
