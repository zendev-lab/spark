export interface PrBodyValidationOutput {
  write(chunk: string): unknown;
}

export interface PrBodyValidationResult {
  valid: boolean;
  expected: string[];
  actual: string[];
}

export function extractH2Headings(markdown: string): string[];
export function validatePrBody(body: string, template: string): PrBodyValidationResult;
export function runPrBodyValidation(options?: {
  body?: string;
  templatePath?: string | URL;
  stdout?: PrBodyValidationOutput;
}): Promise<number>;
