export interface MutationLedgerCheckResult {
  ok: boolean;
  errors: string[];
  counts: { included: number; deferred: number };
  total: number;
  unclassified: number;
}
export function validateMutationOwnership(input: {
  ledger: any;
  architecture: any;
  root?: string;
  runnerSource?: string;
}): MutationLedgerCheckResult;
export function checkMutationOwnership(root?: string): MutationLedgerCheckResult;
export function loadMutationLedger(root?: string): {
  ledger: any;
  result: MutationLedgerCheckResult;
  includedPackageIds: string[];
};
