import type { WorkbenchDisplayValue } from "./types";

export function formatWorkbenchValue(value: WorkbenchDisplayValue): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export function safeWorkbenchHref(value: string | undefined): string | undefined {
  const href = value?.trim();
  if (!href) return undefined;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function workbenchStatusTone(status: string | undefined) {
  if (
    status === "completed" ||
    status === "approved" ||
    status === "resolved" ||
    status === "passed"
  )
    return "success";
  if (status === "failed" || status === "denied" || status === "rejected") return "danger";
  if (status === "blocked" || status === "awaiting-approval") return "warning";
  if (status === "running") return "active";
  return "neutral";
}
