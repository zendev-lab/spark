export function validateProductCompatibilityReport<T>(contract: Record<string, any>, report: T): T;
export function validateDatabaseCompatibilityReport<T>(contract: Record<string, any>, report: T): T;
export function deriveCombinedCompatibilityReport(
  contract: Record<string, any>,
  productReport: Record<string, any>,
  databaseReport: Record<string, any>,
): Record<string, any>;
