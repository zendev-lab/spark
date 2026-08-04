import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** One actual provider attempt, independent of the capability that requested it. */
export type SparkProviderAttemptObservation =
  | {
      attemptId: string;
      outcome: "response";
      message: AssistantMessage;
      observedAt: number;
    }
  | {
      attemptId: string;
      outcome: "missing";
      provider?: string;
      model?: string;
      observedAt: number;
    };

export type SparkProviderAttemptObserver = (observation: SparkProviderAttemptObservation) => void;

export function createSparkProviderAttemptId(): string {
  return randomUUID();
}

/** Accounting is observational and must never change provider-call behavior. */
export function observeSparkProviderAttempt(
  observer: SparkProviderAttemptObserver | undefined,
  observation: SparkProviderAttemptObservation,
): void {
  try {
    observer?.(observation);
  } catch {
    // Deliberately isolated from the owning model call.
  }
}
