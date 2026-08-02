export interface LedgerCheckResult {
  ok: boolean;
  errors: string[];
  counts: Record<string, number>;
  total: number;
  unclassified: number;
}
export function validateWorkspaceTestStrategy(input: {
  ledger: any;
  architecture: any;
  root?: string;
}): LedgerCheckResult;
export function checkWorkspaceTestStrategy(root?: string): LedgerCheckResult;
