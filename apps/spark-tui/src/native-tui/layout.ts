import { truncateToWidth, visibleWidth } from "../tui/pi-tui-adapter.ts";

export interface SparkNativeRenderedSections {
  header: readonly string[];
  context: readonly string[];
  detail?: readonly string[];
  detailActive?: boolean;
  auxiliary?: readonly string[];
  transcript: readonly string[];
  queue?: readonly string[];
  composer: readonly string[];
  footer: readonly string[];
  runtimeFooter?: readonly string[];
}

export interface SparkNativeLayoutInput {
  sections: SparkNativeRenderedSections;
  width: number;
  height: number;
}

export function composeSparkNativeFrame(input: SparkNativeLayoutInput): string[] {
  const width = Math.max(1, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  if (height === 0) return [];

  const clean = (lines: readonly string[] | undefined): string[] =>
    (lines ?? [])
      .filter((line) => visibleWidth(line) > 0)
      .map((line) => truncateToWidth(line, width));

  const header = clean(input.sections.header).slice(0, 1);
  const context = clean(input.sections.context).slice(0, 1);
  const detail = input.sections.detailActive ? clean(input.sections.detail) : [];
  const auxiliary = clean(input.sections.auxiliary);
  const transcript = clean(input.sections.transcript);
  const queue = clean(input.sections.queue);
  const composer = clean(input.sections.composer);
  const footer = clean(input.sections.footer);
  const runtimeFooter = clean(input.sections.runtimeFooter);

  const bottom = allocateBottom({ composer, footer, runtimeFooter, height });
  let remaining = height - bottom.length;
  const top = [...header, ...context].slice(0, remaining);
  remaining -= top.length;

  const latestTranscript = remaining > 0 && transcript.length > 0 ? transcript.slice(-1) : [];
  remaining -= latestTranscript.length;

  const olderTranscript = transcript.slice(0, -latestTranscript.length || transcript.length);
  const extras = allocateExtras({ detail, auxiliary, queue, budget: remaining });
  remaining -= extras.length;
  const olderVisible = olderTranscript.slice(-remaining);

  return [...top, ...extras, ...olderVisible, ...latestTranscript, ...bottom].slice(-height);
}

function allocateBottom(input: {
  composer: string[];
  footer: string[];
  runtimeFooter: string[];
  height: number;
}): string[] {
  if (input.height <= 0) return [];
  const complete = [...input.composer, ...input.footer, ...input.runtimeFooter];
  if (complete.length <= input.height) return complete;

  const composer = input.composer.length > 0 ? input.composer.slice(-1) : [];
  let remaining = input.height - composer.length;
  const footer = input.footer.slice(0, remaining);
  remaining -= footer.length;
  const runtimeFooter = input.runtimeFooter.slice(0, remaining);
  return [...composer, ...footer, ...runtimeFooter];
}

function allocateExtras(input: {
  detail: string[];
  auxiliary: string[];
  queue: string[];
  budget: number;
}): string[] {
  const sources = [input.detail, input.auxiliary, input.queue];
  const offsets = sources.map(() => 0);
  const result: string[] = [];
  while (result.length < input.budget) {
    let appended = false;
    for (const [index, source] of sources.entries()) {
      const line = source[offsets[index] ?? 0];
      if (line === undefined || result.length >= input.budget) continue;
      result.push(line);
      offsets[index] = (offsets[index] ?? 0) + 1;
      appended = true;
    }
    if (!appended) break;
  }
  return result;
}
