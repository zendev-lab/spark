export function hubSourceBoundaryViolations(path: string, source: string): string[];

export function checkHubSourceBoundaries(): Promise<{
  sourceFileCount: number;
  violations: string[];
}>;
