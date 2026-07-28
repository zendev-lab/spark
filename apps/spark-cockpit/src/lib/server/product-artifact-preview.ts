import type { PreviewContentFormat } from "@zendev-lab/spark-artifacts";
import { renderProductPreviewDocument } from "@zendev-lab/spark-artifacts/preview-renderer";

export interface StoredProductPreviewInput {
  kind: string;
  title: string;
  contentRef: unknown;
  body: { text: string | null; truncated: boolean } | null;
}

/**
 * Product Artifact transport formats are intentionally coarse (`markdown` or
 * `text`). The original preview format is carried in contentRef so Cockpit can
 * render the canonical Product Artifact document after durable projection.
 */
export function renderStoredProductPreview(input: StoredProductPreviewInput): string | null {
  if (input.kind !== "preview" || !input.body || input.body.text === null || input.body.truncated) {
    return null;
  }
  const format = previewFormatFromContentRef(input.contentRef);
  if (!format) return null;
  return renderProductPreviewDocument({
    title: input.title,
    format,
    content: input.body.text,
  }).html;
}

export function previewFormatFromContentRef(value: unknown): PreviewContentFormat | null {
  if (!isRecord(value)) return null;
  const format = value.previewFormat;
  return isPreviewContentFormat(format) ? format : null;
}

function isPreviewContentFormat(value: unknown): value is PreviewContentFormat {
  return (
    value === "md" ||
    value === "mdx" ||
    value === "html" ||
    value === "a2ui" ||
    value === "spark-ui"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
