export interface CombinedCompatibilityReport extends Record<string, unknown> {
  schemaVersion: number;
  contractSchemaVersion: number;
  candidateVersion: string;
  baselineVersion: string;
  product: { overall: string; reportPath: string };
  database: { overall: string; reportPath: string };
  overall: string;
}

export function validateProductCompatibilityReport<T>(
  contract: Record<string, unknown>,
  report: T,
): T;
export function validateDatabaseCompatibilityReport<T>(
  contract: Record<string, unknown>,
  report: T,
): T;
export function deriveCombinedCompatibilityReport(
  contract: Record<string, unknown>,
  productReport: Record<string, unknown>,
  databaseReport: Record<string, unknown>,
): CombinedCompatibilityReport;
