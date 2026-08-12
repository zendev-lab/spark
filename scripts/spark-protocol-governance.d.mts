export interface SparkProtocolRootReference {
  kind: string;
  index: number;
  text: string;
}

export const SPARK_PROTOCOL_ROOT_SPECIFIER: "@zendev-lab/spark-protocol";
export function isSparkProductionSourcePath(path: string): boolean;
export function findSparkProtocolRootReferences(source: string): SparkProtocolRootReference[];
export function sparkProtocolSubpathBoundaryViolations(subpath: string, source: string): string[];
