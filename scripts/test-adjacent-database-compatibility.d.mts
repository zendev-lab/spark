export interface DatabaseCompatibilityArguments {
  baselineVersion: string;
  candidateDaemonTarball: string;
  candidateHubTarball: string;
  reportPath?: string;
}
export function parseDatabaseCompatibilityArguments(argv: string[]): DatabaseCompatibilityArguments;
export function validateDatabaseMatrixReport<T>(report: T, contract: Record<string, unknown>): T;
export function runDatabaseCompatibilityMatrix(
  input: DatabaseCompatibilityArguments,
  dependencies?: Record<string, unknown>,
): Promise<Record<string, unknown>>;
