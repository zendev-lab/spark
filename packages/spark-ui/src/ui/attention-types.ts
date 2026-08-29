import type { IconName } from "../icons";

export type AttentionGroupId = "needs-you" | "running" | "failed" | "recent";
export type AttentionTone = "warning" | "running" | "danger" | "success" | "neutral";

export interface AttentionQueueItem {
  id: string;
  group: AttentionGroupId;
  title: string;
  context: string;
  detail?: string;
  meta?: string;
  statusLabel: string;
  tone: AttentionTone;
  icon?: IconName;
  href?: string;
  actionLabel?: string;
}

export interface AttentionQueueLabels {
  ariaLabel: string;
  emptyTitle: string;
  emptyBody?: string;
  groups: Record<AttentionGroupId, string>;
}
