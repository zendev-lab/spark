/** Focused native prompt components for select, plain text, and masked secrets. */

import {
  Input,
  Key,
  SelectList,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
} from "../tui/pi-tui-adapter.ts";
import type { SparkHostRenderTheme } from "@zendev-lab/spark-host/types";

interface NativePromptOptions {
  title: string;
  defaultValue?: string;
  secret?: boolean;
}

const ESC = "\x1b";
const BEL = "\x07";
const PI_CURSOR_MARKER = `${ESC}_pi:c${BEL}`;

interface EscapeScanResult {
  end: number;
  preserve: boolean;
}

export function maskNativeSecretRender(line: string): string {
  const promptPrefix = line.startsWith("> ") ? "> " : "";
  let result = promptPrefix;
  let offset = promptPrefix.length;
  while (offset < line.length) {
    const escapeIndex = line.indexOf(ESC, offset);
    if (escapeIndex < 0) return result + maskVisibleSecretText(line.slice(offset));
    result += maskVisibleSecretText(line.slice(offset, escapeIndex));
    const sequence = scanSecretRenderEscape(line, escapeIndex);
    if (!sequence) {
      result += "•";
      offset = escapeIndex + 1;
      continue;
    }
    if (sequence.preserve) result += line.slice(escapeIndex, sequence.end);
    offset = sequence.end;
  }
  return result;
}

function scanSecretRenderEscape(line: string, start: number): EscapeScanResult | undefined {
  if (line.startsWith(PI_CURSOR_MARKER, start)) {
    return { end: start + PI_CURSOR_MARKER.length, preserve: true };
  }
  const kind = line[start + 1];
  if (kind === "[") {
    for (let index = start + 2; index < line.length; index += 1) {
      const code = line.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        const end = index + 1;
        const sequence = line.slice(start, end);
        return { end, preserve: sequence === `${ESC}[7m` || sequence === `${ESC}[27m` };
      }
    }
    return undefined;
  }
  if (kind === "]" || kind === "_") {
    const end = ansiStringSequenceEnd(line, start + 2);
    return end === undefined ? undefined : { end, preserve: false };
  }
  return undefined;
}

function ansiStringSequenceEnd(line: string, contentStart: number): number | undefined {
  const bellEnd = line.indexOf(BEL, contentStart);
  const stringEnd = line.indexOf(`${ESC}\\`, contentStart);
  if (bellEnd >= 0 && (stringEnd < 0 || bellEnd < stringEnd)) return bellEnd + 1;
  return stringEnd < 0 ? undefined : stringEnd + 2;
}

function maskVisibleSecretText(value: string): string {
  return value.replace(/[^\s]/gu, "•");
}

interface NativePromptApp {
  custom<T>(
    factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: T) => void) => Component,
  ): Promise<T>;
}

class NativeInputPrompt implements Component, Focusable {
  private readonly input = new Input();
  private readonly options: NativePromptOptions;
  private readonly theme: SparkHostRenderTheme;
  private readonly done: (value: string | undefined) => void;
  private focusedValue = false;

  constructor(
    options: NativePromptOptions,
    theme: SparkHostRenderTheme,
    done: (value: string | undefined) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.done = done;
    if (options.defaultValue) this.input.setValue(options.defaultValue);
    this.input.onSubmit = (value) => done(value);
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    this.input.handleInput(data);
  }

  render(width: number): string[] {
    const inputLines = this.input.render(Math.max(1, width - 2));
    const renderedInput = this.options.secret ? inputLines.map(maskNativeSecretRender) : inputLines;
    return [
      this.theme.fg("accent", this.theme.bold(this.options.title)),
      ...renderedInput.map((line) => ` ${line}`),
      this.theme.fg("muted", " Enter to submit · Esc to cancel"),
    ];
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

export function presentNativeInputPrompt(
  app: NativePromptApp,
  theme: SparkHostRenderTheme,
  title: string,
  defaultValue?: string,
): Promise<string | undefined> {
  return app.custom<string | undefined>(
    (_tui, _renderTheme, _keys, done) =>
      new NativeInputPrompt({ title, defaultValue }, theme, done),
  );
}

export function presentNativeSecretPrompt(
  app: NativePromptApp,
  theme: SparkHostRenderTheme,
  title: string,
): Promise<string | undefined> {
  return app.custom<string | undefined>(
    (_tui, _renderTheme, _keys, done) =>
      new NativeInputPrompt({ title, secret: true }, theme, done),
  );
}

export function presentNativeSelectPrompt(
  app: NativePromptApp,
  theme: SparkHostRenderTheme,
  title: string,
  options: readonly string[],
): Promise<string | undefined> {
  if (options.length === 0) return Promise.resolve(undefined);
  return app.custom<string | undefined>((_tui, _renderTheme, _keys, done) => {
    const items: SelectItem[] = options.map((label) => ({ value: label, label }));
    const select = new SelectList(items, 10, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("foreground", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("muted", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    select.onSelect = (item) => done(item.value);
    select.onCancel = () => done(undefined);
    return {
      focused: true,
      handleInput: (data: string) => select.handleInput(data),
      render: (width: number) => [theme.fg("accent", theme.bold(title)), ...select.render(width)],
      invalidate: () => select.invalidate(),
    } satisfies Component & Focusable;
  });
}
