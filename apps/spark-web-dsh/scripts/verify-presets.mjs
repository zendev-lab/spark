import { resolve } from "node:path";
import { verifySparkPresetSources } from "../src/cue-presets.ts";

// Verify the packaged, versioned agent-preset sources (default) or an
// explicitly supplied preset root.
const explicit = process.argv[2];
process.stdout.write(
  `${verifySparkPresetSources(explicit === undefined ? undefined : resolve(explicit))}\n`,
);
