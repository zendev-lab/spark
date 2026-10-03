#!/usr/bin/env node
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditExperiment,
  exportExperiment,
  replayTrial,
  unpackExperiment,
} from "./strategy-experiment/audit.mts";
import { prepareExperiment, runExperiment } from "./strategy-experiment/experiment.mts";
import { outputDirectory, repositoryRoot, writeJson } from "./strategy-experiment/suite.mts";

const [command, name, argument] = process.argv.slice(2);
try {
  if (command === "audit-archive" && name) {
    const root = await mkdtemp(join(tmpdir(), "spark-strategy-audit-"));
    try {
      await unpackExperiment(resolve(name), root);
      console.log(JSON.stringify(await auditExperiment(root), null, 2));
    } finally {
      await rm(root, { recursive: true });
    }
  } else if (command && name) {
    const output = outputDirectory(name);
    if (command === "prepare") {
      await mkdir(join(repositoryRoot, "reports/strategy-experiments"), { recursive: true });
      await prepareExperiment(output);
    } else if (command === "run") {
      await runExperiment(output);
      const report = await auditExperiment(output);
      await writeJson(join(output, "report.json"), report);
      console.log(JSON.stringify(report, null, 2));
    } else if (command === "report")
      console.log(JSON.stringify(await auditExperiment(output), null, 2));
    else if (command === "replay" && argument)
      console.log(JSON.stringify(await replayTrial(output, argument), null, 2));
    else if (command === "export" && argument) await exportExperiment(output, resolve(argument));
    else throw new Error("Unknown command or missing argument");
  } else
    throw new Error(
      "Usage: pnpm experiment:strategy prepare|run|report NAME; replay NAME TRIAL_ID; export NAME DESTINATION; audit-archive FILE.json.gz",
    );
} catch (error) {
  console.error(
    JSON.stringify(
      { schema: "spark.strategy-error/v1", comparable: false, error: String(error) },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
