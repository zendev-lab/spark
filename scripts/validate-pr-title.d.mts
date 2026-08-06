export interface PrTitleValidationOutput {
  write(chunk: string): unknown;
}

export function normalizePrTitle(title: string): string;
export function validatePrTitle(title: string): boolean;
export function runPrTitleValidation(options?: {
  title?: string;
  stdout?: PrTitleValidationOutput;
}): number;
