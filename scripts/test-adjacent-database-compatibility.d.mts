export interface DatabaseCompatibilityArguments {
  baselineVersion: string;
  candidateDaemonTarball: string;
  candidateHubTarball: string;
  reportPath?: string;
}
export function parseDatabaseCompatibilityArguments(argv: string[]): DatabaseCompatibilityArguments;
export function validateDatabaseMatrixReport<T>(report: T, contract: Record<string, any>): T;
export function runDatabaseCompatibilityMatrix(
  input: DatabaseCompatibilityArguments,
  dependencies?: Record<string, any>,
): Promise<Record<string, any>>;
