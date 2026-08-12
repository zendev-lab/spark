import type { SparkMessageView, SparkToolCallView } from "@zendev-lab/spark-protocol/presentation";
import type { SparkNativeHubPanel } from "./hub-types.ts";

interface SparkNativeSessionMessageContract {
  role: "system" | "user" | "assistant" | "custom" | "tool" | "thinking";
  text: string;
  viewId?: string;
  queued?: boolean;
  streaming?: boolean;
  viewStatus?: SparkMessageView["status"];
  customType?: string;
  display?: boolean;
  details?: Record<string, unknown>;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: SparkToolCallView["status"] | "success" | "error";
  createdAt?: string;
  updatedAt?: string;
  nativeOrder?: number;
}

interface SparkNativeSubmitContract {
  mode?: "steer" | "followUp";
  submissionId?: string;
}

interface SparkNativeAbortContract {
  aborted: boolean;
  clearedQueued: number;
  restoredText?: string;
}

export interface SparkNativeAppContract {
  executeSlashCommand(input: string): Promise<void> | void;
  openHubPanel(panel: SparkNativeHubPanel): string | false;
  openHubPanelFromArgs(args: string): string | false;
  renderQueueInspection(): string;
  secret(title: string): Promise<string | undefined>;
  select(title: string, options: readonly string[]): Promise<string | undefined>;
  setEditorText(text: string): void;
}

export interface SparkNativeSessionContract {
  readonly messages: SparkNativeSessionMessageContract[];
  abort(reason: string): SparkNativeAbortContract;
  addSystemMessage(text: string): void;
  clearTranscript(note?: string): void;
  retryLast(): unknown;
  restoreQueuedText(): string | undefined;
  submit(
    input: string,
    options?: SparkNativeSubmitContract,
  ): Promise<"started" | "queued" | "ignored">;
}
