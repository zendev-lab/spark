import type { SparkAuthStore } from "./auth.ts";

export type SparkOAuthFlowPhase =
  | "running"
  | "waiting_for_input"
  | "complete"
  | "failed"
  | "cancelled";

export interface SparkOAuthFlowPrompt {
  id: string;
  kind: "text" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
  options?: Array<{ id: string; label: string }>;
}

export interface SparkOAuthFlowSnapshot {
  id: string;
  providerId: string;
  phase: SparkOAuthFlowPhase;
  createdAt: string;
  updatedAt: string;
  auth?: { url: string; instructions?: string };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  };
  prompt?: SparkOAuthFlowPrompt;
  progress: string[];
  error?: string;
}

export interface SparkOAuthFlowBrokerOptions {
  store: SparkAuthStore;
  now?: () => Date;
  completedFlowTtlMs?: number;
}
