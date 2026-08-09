export interface SourceMirrorAssertion {
  file: string;
  line: number;
  sourceVariable: string;
  assertion: string;
}

export interface BrittlePromptTextAssertion {
  file: string;
  line: number;
  subject: string;
  assertion: string;
}

export function findBrittlePromptTextAssertions(
  sourceText: string,
  fileName?: string,
): BrittlePromptTextAssertion[];

export function findSourceMirrorAssertions(
  sourceText: string,
  fileName?: string,
): SourceMirrorAssertion[];
