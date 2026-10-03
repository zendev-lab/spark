import { render } from "vitest-browser-svelte";
import { describe, expect, it, vi } from "vitest";

import SessionWorkPanel from "./SessionWorkPanel.svelte";

const labels = {
  region: "Session work",
  work: "Work",
  activity: "Activity",
  details: "Details",
  emptyWork: "No work",
  emptyActivity: "No activity",
  emptyDetails: "No details",
  goal: "Goal",
  repro: "Repro",
  loop: "Loop",
  workflow: "Workflow",
  task: "Task",
  toolInput: "Input",
  toolOutput: "Output",
  toolError: "Error",
  toolEmpty: "Empty",
  artifactPreview: "Preview",
  openArtifact: "Open",
};

describe("SessionWorkPanel browser contract", () => {
  it("projects owner state into Work, Activity, and Details without inferring it", async () => {
    const onOpenArtifact = vi.fn();
    const screen = await render(SessionWorkPanel, {
      labels,
      onOpenArtifact,
      snapshot: {
        sessionId: "session-1",
        status: "idle",
        messages: [],
        work: {
          goal: {
            goalId: "goal-1",
            objective: "Ship owner API",
            status: "active",
            updatedAt: "2026-08-21T00:00:00.000Z",
          },
        },
        tools: [{ id: "tool-1", name: "artifact", status: "completed", metadata: {} }],
        runs: [],
        tasks: [],
        artifacts: [
          {
            ref: "artifact:report",
            title: "Report",
            kind: "document",
            format: "markdown",
            metadata: {},
          },
        ],
        evidence: [],
        metadata: {},
      },
    });

    await expect.element(screen.getByText(/Ship owner API/)).toBeVisible();
    await screen.getByRole("tab", { name: "Activity" }).click();
    await expect.element(screen.getByText("artifact")).toBeVisible();
    await screen.getByRole("tab", { name: "Details" }).click();
    await screen.getByRole("button", { name: "Open" }).click();
    expect(onOpenArtifact).toHaveBeenCalledWith("artifact:report");
    await screen.unmount();
  });
});
