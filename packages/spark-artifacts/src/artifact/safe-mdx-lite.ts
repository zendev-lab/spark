export type SafeMdxLiteTone = "info" | "success" | "warning" | "error";

export type SafeMdxLiteBlock =
  | { type: "markdown"; text: string }
  | { type: "callout"; tone: SafeMdxLiteTone; title?: string; body: string };

export interface SafeMdxLiteDiagnostic {
  severity: "warning" | "error";
  message: string;
  line?: number;
}

export interface SafeMdxLiteDocument {
  blocks: SafeMdxLiteBlock[];
  diagnostics: SafeMdxLiteDiagnostic[];
}

/**
 * Parse the canonical writable MDX-lite dialect.
 *
 * This deliberately does not share the retired Spark UI AST or component
 * catalog. Writable MDX has one inert, presentation-only extension:
 * `<Callout>`. Artifact/task/run references remain typed conversation parts.
 */
export function parseSafeMdxLite(source: string): SafeMdxLiteDocument {
  const blocks: SafeMdxLiteBlock[] = [];
  const diagnostics: SafeMdxLiteDiagnostic[] = [];
  const markdown: string[] = [];
  const lines = source.split(/\r?\n/u);
  let fence: MarkdownFence | undefined;

  const flushMarkdown = () => {
    const text = markdown.join("\n").trim();
    markdown.length = 0;
    if (text) blocks.push({ type: "markdown", text });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (fence) {
      markdown.push(line);
      if (closesFence(trimmed, fence)) fence = undefined;
      continue;
    }
    const openingFence = fenceFromLine(trimmed);
    if (openingFence) {
      fence = openingFence;
      markdown.push(line);
      continue;
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      markdown.push(line);
      continue;
    }

    if (/^(?:import|export)\b/u.test(trimmed)) {
      flushMarkdown();
      diagnostics.push({
        severity: "error",
        line: index + 1,
        message: "imports and exports are not allowed in Safe MDX-lite",
      });
      continue;
    }

    const inlineCallout = trimmed.match(/^<Callout\b([^>]*)>(.*?)<\/Callout>\s*$/u);
    if (inlineCallout) {
      flushMarkdown();
      const parsed = parseCalloutAttributes(inlineCallout[1] ?? "", index + 1, diagnostics);
      if (parsed) {
        blocks.push({
          type: "callout",
          tone: parsed.tone,
          ...(parsed.title ? { title: parsed.title } : {}),
          body: inlineCallout[2] ?? "",
        });
      }
      continue;
    }

    const callout = trimmed.match(/^<Callout\b([^>]*)>\s*$/u);
    if (callout) {
      flushMarkdown();
      const closingIndex = findClosingTag(lines, index + 1, "Callout");
      if (closingIndex === undefined) {
        diagnostics.push({
          severity: "warning",
          line: index + 1,
          message: "incomplete Callout tag was omitted; its body remains inert Markdown",
        });
        continue;
      }
      const parsed = parseCalloutAttributes(callout[1] ?? "", index + 1, diagnostics);
      if (parsed) {
        blocks.push({
          type: "callout",
          tone: parsed.tone,
          ...(parsed.title ? { title: parsed.title } : {}),
          body: lines.slice(index + 1, closingIndex).join("\n"),
        });
      }
      index = closingIndex;
      continue;
    }

    const component = trimmed.match(/^<([A-Z][A-Za-z0-9]*)\b/u);
    if (component) {
      flushMarkdown();
      const name = component[1] ?? "component";
      diagnostics.push({
        severity: "error",
        line: index + 1,
        message: `unsupported Safe MDX-lite component ${name}`,
      });
      if (!trimmed.endsWith("/>") && trimmed.endsWith(">")) {
        const closingIndex = findClosingTag(lines, index + 1, name);
        if (closingIndex !== undefined) index = closingIndex;
      }
      continue;
    }

    markdown.push(line);
  }

  flushMarkdown();
  return { blocks, diagnostics };
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

function fenceFromLine(line: string): MarkdownFence | undefined {
  const match = line.match(/^(`{3,}|~{3,})/u);
  const marker = match?.[1];
  if (!marker) return undefined;
  return { marker: marker[0] as "`" | "~", length: marker.length };
}

function closesFence(line: string, fence: MarkdownFence): boolean {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^${marker}{${fence.length},}\\s*$`, "u").test(line);
}

function findClosingTag(
  lines: readonly string[],
  startIndex: number,
  name: string,
): number | undefined {
  const closingTag = `</${name}>`;
  for (let index = startIndex; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === closingTag) return index;
  }
  return undefined;
}

function parseCalloutAttributes(
  source: string,
  line: number,
  diagnostics: SafeMdxLiteDiagnostic[],
): { tone: SafeMdxLiteTone; title?: string } | undefined {
  if (/[{}]/u.test(source)) {
    diagnostics.push({
      severity: "error",
      line,
      message: "expressions are not allowed in Safe MDX-lite attributes",
    });
    return undefined;
  }

  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z][A-Za-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/uy;
  let cursor = 0;
  while (cursor < source.length) {
    while (/\s/u.test(source[cursor] ?? "")) cursor += 1;
    if (cursor >= source.length) break;
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) {
      diagnostics.push({
        severity: "error",
        line,
        message: "Callout attributes must be quoted static strings",
      });
      return undefined;
    }
    const name = match[1] ?? "";
    if (name !== "tone" && name !== "title") {
      diagnostics.push({
        severity: "error",
        line,
        message: `unsupported Callout attribute ${name}`,
      });
      return undefined;
    }
    if (attributes.has(name)) {
      diagnostics.push({ severity: "error", line, message: `duplicate Callout attribute ${name}` });
      return undefined;
    }
    attributes.set(name, match[2] ?? match[3] ?? "");
    cursor = pattern.lastIndex;
  }

  const tone = attributes.get("tone") ?? "info";
  if (tone !== "info" && tone !== "success" && tone !== "warning" && tone !== "error") {
    diagnostics.push({ severity: "error", line, message: `unsupported Callout tone ${tone}` });
    return undefined;
  }
  const title = attributes.get("title");
  return { tone, ...(title ? { title } : {}) };
}
