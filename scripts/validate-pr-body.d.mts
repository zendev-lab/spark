export interface PrBodyValidationOutput {
  write(chunk: string): unknown;
}

export interface PrBodyTemplateSection {
  heading: string;
  required: boolean;
}

export interface PrBodyValidationResult {
  valid: boolean;
  expected: string[];
  required: string[];
  optional: string[];
  actual: string[];
}

export function extractH2Headings(markdown: string): string[];
export function extractTemplateSections(template: string): PrBodyTemplateSection[];
export function validatePrBody(body: string, template: string): PrBodyValidationResult;
export function runPrBodyValidation(options?: {
  body?: string;
  templatePath?: string | URL;
  stdout?: PrBodyValidationOutput;
}): Promise<number>;
