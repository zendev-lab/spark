import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

import { renderReproTickInstruction } from "../packages/spark-extension/src/extension/spark-repro-tool-registration.ts";
import {
  createSparkSessionRepro,
  type SparkReproStageName,
} from "../packages/spark-extension/src/extension/spark-session-repro.ts";

const snapshotDir = join(dirname(fileURLToPath(import.meta.url)), "snapshots");
const stageNames = ["setup", "scaffold", "reproduce", "scale", "deliver"] as const;

function instructionForStage(stageName: SparkReproStageName): string {
  const repro = createSparkSessionRepro(`session:${stageName}`);
  const currentStageIndex = repro.stages.findIndex((stage) => stage.name === stageName);
  const stage = repro.stages[currentStageIndex];
  if (!stage) throw new Error(`missing repro stage: ${stageName}`);
  return renderReproTickInstruction({
    ...repro,
    currentStageIndex,
    currentPhase: stage.phases[0]!,
  });
}

test.each(stageNames)(
  "repro %s tick matches the reviewed user-visible instruction golden",
  async (stageName) => {
    const instruction = instructionForStage(stageName);
    expect(instruction).toContain("Orchestration loop:");
    expect(instruction).toContain("Use assign to dispatch independent ready tasks in parallel.");
    expect(instruction).toContain(
      "Never dispatch ask_decision or ask_approval authority tasks; they remain owner-only.",
    );
    expect(instruction).not.toContain("execute one typed plan step per tick");

    // Runtime instructions omit the final newline; repository text files retain it.
    await expect(instruction + "\n").toMatchFileSnapshot(
      join(snapshotDir, `spark-repro-tick-${stageName}.md`),
    );
  },
);
