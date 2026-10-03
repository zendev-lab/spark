import type { SparkDshSessionDocument } from "./dsh-format.ts";

export function restoreLegacyDshSession(document: SparkDshSessionDocument): {
  surface: { nodes: readonly number[] };
};
