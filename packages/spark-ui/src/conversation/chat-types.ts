import type { BrandIconName } from "../brand-icons";

export type ConversationAttachmentKind = "image" | "audio" | "file";

export type ConversationAttachmentView = Readonly<{
  id: string;
  name: string;
  kind: ConversationAttachmentKind;
  mediaType?: string;
  sizeBytes?: number;
  previewHref?: string;
  href?: string;
}>;

export type ConversationSourceView = Readonly<{
  id: string;
  title: string;
  href: string;
  description?: string;
  domain?: string;
}>;

export type ConversationBranchView = Readonly<{
  current: number;
  total: number;
}>;

export type ConversationSuggestionView = Readonly<{
  id: string;
  label: string;
  description?: string;
  value: string;
}>;

export type ConversationModelOption = Readonly<{
  value: string;
  label: string;
  description?: string;
  keywords?: readonly string[];
  reasoning?: boolean;
  disabled?: boolean;
}>;

export type ConversationModelGroup = Readonly<{
  id: string;
  label: string;
  description?: string;
  brandIcon?: BrandIconName;
  options: readonly ConversationModelOption[];
}>;

export type ConversationContextUsageView = Readonly<{
  used: number;
  limit: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}>;

export type ConversationSpeechState = "idle" | "requesting" | "recording" | "processing" | "error";
