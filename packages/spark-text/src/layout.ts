/**
 * Terminal-column width, truncation, and ANSI-aware wrapping.
 *
 * The algorithm is adapted from MIT-licensed `@earendil-works/pi-tui` so Spark
 * packages can measure text without taking a Pi TUI dependency.
 */

import { eastAsianWidth } from "get-east-asian-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const zeroWidthRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const leadingNonPrintingRegex =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const nonPrintingCharRegex =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/v;
const markCharRegex = /^\p{Mark}$/v;
const terminalSpacingMarkRegex =
  /^(?:[\p{Spacing_Mark}--[\u1734\u302E\u302F]]|[\u065F\u0F7F\u102B\u102C\u1031\u1033-\u1035\u1038\u103A-\u103E])+$/v;
const rgiEmojiRegex = /^\p{RGI_Emoji}$/v;
const cjkBreakRegex =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

type Osc8Hyperlink = {
  params: string;
  url: string;
  terminator: string;
};

function couldBeEmoji(segment: string): boolean {
  const cp = segment.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1f000 && cp <= 0x1fbff) ||
    (cp >= 0x2300 && cp <= 0x23ff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b50 && cp <= 0x2b55) ||
    segment.includes("\uFE0F") ||
    segment.length > 2
  );
}

function isPrintableAscii(str: string): boolean {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function unicodeCharacters(value: string): string[] {
  const characters: string[] = [];
  for (const character of value) characters.push(character);
  return characters;
}

function extractAnsiCode(str: string, pos: number): { code: string; length: number } | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length && !/[mGKHJ]/.test(str[j] ?? "")) j += 1;
    if (j < str.length) return { code: str.slice(pos, j + 1), length: j + 1 - pos };
    return null;
  }
  if (next === "]" || next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") {
        return { code: str.slice(pos, j + 2), length: j + 2 - pos };
      }
      j += 1;
    }
    return null;
  }
  return null;
}

function parseOsc8Hyperlink(ansiCode: string): Osc8Hyperlink | null | undefined {
  if (!ansiCode.startsWith("\x1b]8;")) return undefined;
  const terminator = ansiCode.endsWith("\x07") ? "\x07" : "\x1b\\";
  const body = ansiCode.slice(4, terminator === "\x07" ? -1 : -2);
  const separatorIndex = body.indexOf(";");
  if (separatorIndex === -1) return undefined;
  const params = body.slice(0, separatorIndex);
  const url = body.slice(separatorIndex + 1);
  if (!url) return null;
  return { params, url, terminator };
}

function formatOsc8Hyperlink(hyperlink: Osc8Hyperlink): string {
  return `\x1b]8;${hyperlink.params};${hyperlink.url}${hyperlink.terminator}`;
}

function formatOsc8Close(terminator: string): string {
  return `\x1b]8;;${terminator}`;
}

function getActiveOsc8Close(prefix: string): string {
  if (!prefix.includes("\x1b]8;")) return "";
  let activeHyperlink: Osc8Hyperlink | null = null;
  let i = 0;
  while (i < prefix.length) {
    const ansi = extractAnsiCode(prefix, i);
    if (ansi) {
      const hyperlink = parseOsc8Hyperlink(ansi.code);
      if (hyperlink !== undefined) activeHyperlink = hyperlink;
      i += ansi.length;
    } else {
      i += 1;
    }
  }
  return activeHyperlink ? formatOsc8Close(activeHyperlink.terminator) : "";
}

function graphemeWidth(segment: string): number {
  if (segment === "\t") return 3;
  if (terminalSpacingMarkRegex.test(segment)) return unicodeCharacters(segment).length;
  if (zeroWidthRegex.test(segment)) return 0;
  if (couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) return 2;

  const base = segment.replace(leadingNonPrintingRegex, "");
  const cp = base.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;

  let width = eastAsianWidth(cp);
  let followsMark = false;
  const chars = unicodeCharacters(base);
  for (const char of chars.slice(1)) {
    if (terminalSpacingMarkRegex.test(char)) {
      width += 1;
      followsMark = false;
    } else if (markCharRegex.test(char)) {
      followsMark = true;
    } else if (!nonPrintingCharRegex.test(char)) {
      const extra = char.codePointAt(0);
      if (extra === undefined) continue;
      if (followsMark || (extra >= 0xff00 && extra <= 0xffef)) {
        width += eastAsianWidth(extra);
      } else if (extra === 0x0e33 || extra === 0x0eb3) {
        width += 1;
      }
      followsMark = false;
    }
  }
  return width;
}

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
  if (maxWidth <= 0 || text.length === 0) return { text: "", width: 0 };
  if (isPrintableAscii(text)) {
    const clipped = text.slice(0, maxWidth);
    return { text: clipped, width: clipped.length };
  }
  const hasAnsi = text.includes("\x1b");
  const hasTabs = text.includes("\t");
  if (!hasAnsi && !hasTabs) {
    let result = "";
    let width = 0;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const w = graphemeWidth(segment);
      if (width + w > maxWidth) break;
      result += segment;
      width += w;
    }
    return { text: result, width };
  }
  let result = "";
  let width = 0;
  let i = 0;
  let pendingAnsi = "";
  while (i < text.length) {
    const ansi = extractAnsiCode(text, i);
    if (ansi) {
      pendingAnsi += ansi.code;
      i += ansi.length;
      continue;
    }
    if (text[i] === "\t") {
      if (width + 3 > maxWidth) break;
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += "\t";
      width += 3;
      i += 1;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] !== "\t") {
      if (extractAnsiCode(text, end)) break;
      end += 1;
    }
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const w = graphemeWidth(segment);
      if (width + w > maxWidth) return { text: result, width };
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += segment;
      width += w;
    }
    i = end;
  }
  return { text: result, width };
}

function finalizeTruncatedResult(
  prefix: string,
  prefixWidth: number,
  ellipsis: string,
  ellipsisWidth: number,
  maxWidth: number,
  pad: boolean,
): string {
  const reset = "\x1b[0m";
  const hyperlinkClose = getActiveOsc8Close(prefix);
  const usedWidth = prefixWidth + ellipsisWidth;
  const result =
    ellipsis.length > 0
      ? `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`
      : `${prefix}${hyperlinkClose}${reset}`;
  return pad ? result + " ".repeat(Math.max(0, maxWidth - usedWidth)) : result;
}

class AnsiCodeTracker {
  bold = false;
  dim = false;
  italic = false;
  underline = false;
  blink = false;
  inverse = false;
  hidden = false;
  strikethrough = false;
  fgColor: string | null = null;
  bgColor: string | null = null;
  activeHyperlink: Osc8Hyperlink | null = null;

  process(ansiCode: string): void {
    const hyperlink = parseOsc8Hyperlink(ansiCode);
    if (hyperlink !== undefined) {
      this.activeHyperlink = hyperlink;
      return;
    }
    if (!ansiCode.endsWith("m")) return;
    const match = ansiCode.match(/\x1b\[([\d;]*)m/);
    if (!match) return;
    const params = match[1];
    if (params === "" || params === "0") {
      this.reset();
      return;
    }
    const parts = params.split(";");
    let i = 0;
    while (i < parts.length) {
      const code = Number.parseInt(parts[i] ?? "", 10);
      if (code === 38 || code === 48) {
        if (parts[i + 1] === "5" && parts[i + 2] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]}`;
          if (code === 38) this.fgColor = colorCode;
          else this.bgColor = colorCode;
          i += 3;
          continue;
        }
        if (parts[i + 1] === "2" && parts[i + 4] !== undefined) {
          const colorCode = `${parts[i]};${parts[i + 1]};${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}`;
          if (code === 38) this.fgColor = colorCode;
          else this.bgColor = colorCode;
          i += 5;
          continue;
        }
      }
      switch (code) {
        case 0:
          this.reset();
          break;
        case 1:
          this.bold = true;
          break;
        case 2:
          this.dim = true;
          break;
        case 3:
          this.italic = true;
          break;
        case 4:
          this.underline = true;
          break;
        case 5:
          this.blink = true;
          break;
        case 7:
          this.inverse = true;
          break;
        case 8:
          this.hidden = true;
          break;
        case 9:
          this.strikethrough = true;
          break;
        case 21:
          this.bold = false;
          break;
        case 22:
          this.bold = false;
          this.dim = false;
          break;
        case 23:
          this.italic = false;
          break;
        case 24:
          this.underline = false;
          break;
        case 25:
          this.blink = false;
          break;
        case 27:
          this.inverse = false;
          break;
        case 28:
          this.hidden = false;
          break;
        case 29:
          this.strikethrough = false;
          break;
        case 39:
          this.fgColor = null;
          break;
        case 49:
          this.bgColor = null;
          break;
        default:
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            this.fgColor = String(code);
          } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
            this.bgColor = String(code);
          }
          break;
      }
      i += 1;
    }
  }

  reset(): void {
    this.bold = false;
    this.dim = false;
    this.italic = false;
    this.underline = false;
    this.blink = false;
    this.inverse = false;
    this.hidden = false;
    this.strikethrough = false;
    this.fgColor = null;
    this.bgColor = null;
  }

  getActiveCodes(): string {
    const codes: string[] = [];
    if (this.bold) codes.push("1");
    if (this.dim) codes.push("2");
    if (this.italic) codes.push("3");
    if (this.underline) codes.push("4");
    if (this.blink) codes.push("5");
    if (this.inverse) codes.push("7");
    if (this.hidden) codes.push("8");
    if (this.strikethrough) codes.push("9");
    if (this.fgColor) codes.push(this.fgColor);
    if (this.bgColor) codes.push(this.bgColor);
    let result = codes.length > 0 ? `\x1b[${codes.join(";")}m` : "";
    if (this.activeHyperlink) result += formatOsc8Hyperlink(this.activeHyperlink);
    return result;
  }

  getLineEndReset(): string {
    let result = "";
    if (this.underline) result += "\x1b[24m";
    if (this.activeHyperlink) result += formatOsc8Close(this.activeHyperlink.terminator);
    return result;
  }
}

function updateTrackerFromText(text: string, tracker: AnsiCodeTracker): void {
  let i = 0;
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i);
    if (ansiResult) {
      tracker.process(ansiResult.code);
      i += ansiResult.length;
    } else {
      i += 1;
    }
  }
}

function splitIntoTokensWithAnsi(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let pendingAnsi = "";
  let currentKind: "space" | "word" | null = null;
  let i = 0;
  const flushCurrent = (): void => {
    if (!current) return;
    tokens.push(current);
    current = "";
    currentKind = null;
  };
  while (i < text.length) {
    const ansiResult = extractAnsiCode(text, i);
    if (ansiResult) {
      pendingAnsi += ansiResult.code;
      i += ansiResult.length;
      continue;
    }
    let end = i;
    while (end < text.length && !extractAnsiCode(text, end)) end += 1;
    for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
      const segmentIsSpace = segment === " ";
      if (!segmentIsSpace && cjkBreakRegex.test(segment)) {
        flushCurrent();
        const token = pendingAnsi + segment;
        pendingAnsi = "";
        tokens.push(token);
        continue;
      }
      const segmentKind = segmentIsSpace ? "space" : "word";
      if (current && currentKind !== segmentKind) flushCurrent();
      if (pendingAnsi) {
        current += pendingAnsi;
        pendingAnsi = "";
      }
      currentKind = segmentKind;
      current += segment;
    }
    i = end;
  }
  if (pendingAnsi) {
    if (current) current += pendingAnsi;
    else if (tokens.length > 0) tokens[tokens.length - 1] += pendingAnsi;
    else current = pendingAnsi;
  }
  if (current) tokens.push(current);
  return tokens;
}

function breakLongWord(word: string, width: number, tracker: AnsiCodeTracker): string[] {
  const lines: string[] = [];
  let currentLine = tracker.getActiveCodes();
  let currentWidth = 0;
  let i = 0;
  const segments: Array<{ type: "ansi" | "grapheme"; value: string }> = [];
  while (i < word.length) {
    const ansiResult = extractAnsiCode(word, i);
    if (ansiResult) {
      segments.push({ type: "ansi", value: ansiResult.code });
      i += ansiResult.length;
      continue;
    }
    let end = i;
    while (end < word.length) {
      if (extractAnsiCode(word, end)) break;
      end += 1;
    }
    for (const seg of graphemeSegmenter.segment(word.slice(i, end))) {
      segments.push({ type: "grapheme", value: seg.segment });
    }
    i = end;
  }
  for (const seg of segments) {
    if (seg.type === "ansi") {
      currentLine += seg.value;
      tracker.process(seg.value);
      continue;
    }
    const grapheme = seg.value;
    if (!grapheme) continue;
    const nextWidth = visibleWidth(grapheme);
    if (currentWidth + nextWidth > width) {
      const lineEndReset = tracker.getLineEndReset();
      if (lineEndReset) currentLine += lineEndReset;
      lines.push(currentLine);
      currentLine = tracker.getActiveCodes();
      currentWidth = 0;
    }
    currentLine += grapheme;
    currentWidth += nextWidth;
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [""];
}

function wrapSingleLine(line: string, width: number): string[] {
  if (!line) return [""];
  if (visibleWidth(line) <= width) return [line];
  const wrapped: string[] = [];
  const tracker = new AnsiCodeTracker();
  const tokens = splitIntoTokensWithAnsi(line);
  let currentLine = "";
  let currentVisibleLength = 0;
  for (const token of tokens) {
    const tokenVisibleLength = visibleWidth(token);
    const isWhitespace = token.trim() === "";
    if (tokenVisibleLength > width && !isWhitespace) {
      if (currentLine) {
        const lineEndReset = tracker.getLineEndReset();
        if (lineEndReset) currentLine += lineEndReset;
        wrapped.push(currentLine);
        currentLine = "";
        currentVisibleLength = 0;
      }
      const broken = breakLongWord(token, width, tracker);
      for (let i = 0; i < broken.length - 1; i += 1) wrapped.push(broken[i] ?? "");
      currentLine = broken[broken.length - 1] ?? "";
      currentVisibleLength = visibleWidth(currentLine);
      continue;
    }
    const totalNeeded = currentVisibleLength + tokenVisibleLength;
    if (totalNeeded > width && currentVisibleLength > 0) {
      let lineToWrap = currentLine.trimEnd();
      const lineEndReset = tracker.getLineEndReset();
      if (lineEndReset) lineToWrap += lineEndReset;
      wrapped.push(lineToWrap);
      if (isWhitespace) {
        currentLine = tracker.getActiveCodes();
        currentVisibleLength = 0;
      } else {
        currentLine = tracker.getActiveCodes() + token;
        currentVisibleLength = tokenVisibleLength;
      }
    } else {
      currentLine += token;
      currentVisibleLength += tokenVisibleLength;
    }
    updateTrackerFromText(token, tracker);
  }
  if (currentLine) wrapped.push(currentLine);
  return wrapped.length > 0 ? wrapped.map((item) => item.trimEnd()) : [""];
}

export function visibleWidth(str: string): number {
  if (str.length === 0) return 0;
  if (isPrintableAscii(str)) return str.length;
  const cached = widthCache.get(str);
  if (cached !== undefined) return cached;
  let clean = str;
  if (str.includes("\t")) clean = clean.replaceAll("\t", "   ");
  if (clean.includes("\x1b")) {
    let stripped = "";
    let i = 0;
    while (i < clean.length) {
      const ansi = extractAnsiCode(clean, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      stripped += clean[i];
      i += 1;
    }
    clean = stripped;
  }
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(clean)) {
    width += graphemeWidth(segment);
  }
  if (widthCache.size >= WIDTH_CACHE_SIZE) {
    const firstKey = widthCache.keys().next().value;
    if (firstKey !== undefined) widthCache.delete(firstKey);
  }
  widthCache.set(str, width);
  return width;
}

export function wrapTextWithAnsi(text: string, width: number): string[] {
  if (!text) return [""];
  const inputLines = text.split(/\r\n|\r|\n/);
  const result: string[] = [];
  const tracker = new AnsiCodeTracker();
  for (const inputLine of inputLines) {
    const prefix = result.length > 0 ? tracker.getActiveCodes() : "";
    result.push(...wrapSingleLine(prefix + inputLine, width));
    updateTrackerFromText(inputLine, tracker);
  }
  return result.length > 0 ? result : [""];
}

export function truncateToWidth(
  text: string,
  maxWidth: number,
  ellipsis = "...",
  pad = false,
): string {
  if (maxWidth <= 0) return "";
  if (text.length === 0) return pad ? " ".repeat(maxWidth) : "";
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    const textWidth = visibleWidth(text);
    if (textWidth <= maxWidth) return pad ? text + " ".repeat(maxWidth - textWidth) : text;
    const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
    if (clippedEllipsis.width === 0) return pad ? " ".repeat(maxWidth) : "";
    return finalizeTruncatedResult(
      "",
      0,
      clippedEllipsis.text,
      clippedEllipsis.width,
      maxWidth,
      pad,
    );
  }
  if (isPrintableAscii(text)) {
    if (text.length <= maxWidth) return pad ? text + " ".repeat(maxWidth - text.length) : text;
    const targetWidth = maxWidth - ellipsisWidth;
    return finalizeTruncatedResult(
      text.slice(0, targetWidth),
      targetWidth,
      ellipsis,
      ellipsisWidth,
      maxWidth,
      pad,
    );
  }
  const targetWidth = maxWidth - ellipsisWidth;
  let result = "";
  let pendingAnsi = "";
  let visibleSoFar = 0;
  let keptWidth = 0;
  let keepContiguousPrefix = true;
  let overflowed = false;
  let exhaustedInput = false;
  const hasAnsi = text.includes("\x1b");
  const hasTabs = text.includes("\t");
  if (!hasAnsi && !hasTabs) {
    for (const { segment } of graphemeSegmenter.segment(text)) {
      const width = graphemeWidth(segment);
      if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
        result += segment;
        keptWidth += width;
      } else {
        keepContiguousPrefix = false;
      }
      visibleSoFar += width;
      if (visibleSoFar > maxWidth) {
        overflowed = true;
        break;
      }
    }
    exhaustedInput = !overflowed;
  } else {
    let i = 0;
    while (i < text.length) {
      const ansi = extractAnsiCode(text, i);
      if (ansi) {
        pendingAnsi += ansi.code;
        i += ansi.length;
        continue;
      }
      if (text[i] === "\t") {
        if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += "\t";
          keptWidth += 3;
        } else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += 3;
        if (visibleSoFar > maxWidth) {
          overflowed = true;
          break;
        }
        i += 1;
        continue;
      }
      let end = i;
      while (end < text.length && text[end] !== "\t") {
        if (extractAnsiCode(text, end)) break;
        end += 1;
      }
      for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
        const width = graphemeWidth(segment);
        if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
          if (pendingAnsi) {
            result += pendingAnsi;
            pendingAnsi = "";
          }
          result += segment;
          keptWidth += width;
        } else {
          keepContiguousPrefix = false;
          pendingAnsi = "";
        }
        visibleSoFar += width;
        if (visibleSoFar > maxWidth) {
          overflowed = true;
          break;
        }
      }
      if (overflowed) break;
      i = end;
    }
    exhaustedInput = i >= text.length;
  }
  if (!overflowed && exhaustedInput) {
    return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
  }
  return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}
