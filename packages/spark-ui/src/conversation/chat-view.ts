import type { ConversationAttachmentKind, ConversationContextUsageView } from "./chat-types";

export function formatAttachmentSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return undefined;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${roundToOneDecimal(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${roundToOneDecimal(bytes / (1024 * 1024))} MB`;
  return `${roundToOneDecimal(bytes / (1024 * 1024 * 1024))} GB`;
}

export function attachmentKindForMediaType(mediaType: string): ConversationAttachmentKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  return "file";
}

export function contextUsagePercent(view: ConversationContextUsageView): number {
  if (!Number.isFinite(view.used) || !Number.isFinite(view.limit) || view.limit <= 0) return 0;
  return Math.min(100, Math.max(0, (view.used / view.limit) * 100));
}

export function safeConversationHref(value: string | undefined): string | undefined {
  const href = value?.trim();
  if (!href) return undefined;
  if (href.startsWith("/")) return href;
  try {
    const parsed = new URL(href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function roundToOneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  });
}
