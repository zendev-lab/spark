export interface TestOwnershipResult {
  ok: boolean;
  strictOk: boolean;
  errors: string[];
  structuralErrors: string[];
  counts: { "owner-local": number; "root-integration": number };
  total: number;
  baselineTotal: number;
  pending: {
    migrations: Array<{ baselinePath: string; currentPath: string; owner: string }>;
    integrationDeepImports: Array<{ baselinePath: string; currentPath: string; imports: string[] }>;
  };
  pendingCount: number;
}
export function readBaselinePaths(root?: string, source?: string): string[];
export function validateTestOwnership(input: {
  ledger: any;
  architecture: any;
  root?: string;
  baselinePaths?: string[];
  strict?: boolean;
}): TestOwnershipResult;
export function checkTestOwnership(
  root?: string,
  options?: { strict?: boolean },
): TestOwnershipResult;
