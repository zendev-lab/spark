import type {
  SessionActivityProjection,
  SessionActivityCommand,
  SessionActivityQueuedTurn,
  SessionActivityReport,
} from "@zendev-lab/spark-cockpit-coordination/session-activity";
import type { SparkModelControlSnapshot, SparkSessionRelation } from "@zendev-lab/spark-protocol";
import type { CockpitMessages } from "@zendev-lab/spark-i18n/cockpit";

/** Canonical session activity projection; UI previously re-declared a near-isomorphic subset. */
export type SessionActivity = SessionActivityProjection;
export type { SessionActivityCommand, SessionActivityQueuedTurn, SessionActivityReport };

export type SessionRecord = {
  sessionId: string;
  workspaceId?: string;
  scope?:
    | { kind: "workspace"; workspaceId: string }
    | { kind: "daemon"; daemonId?: string; daemonLabel?: string };
  title?: string;
  status: string;
  role?: string;
  relation?: SparkSessionRelation;
  bindings?: Array<{
    kind: string;
    adapter?: string;
    externalKey?: string;
    boundAt?: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceOption = {
  id: string;
  slug: string;
  name: string;
  localPath?: string | null;
};

export type SessionCwdRootOption = {
  artifactRef: string;
  label: string;
  path: string;
};

export type FormValues = {
  workspaceId?: string;
  cwd?: string;
  cwdArtifactRef?: string;
  sessionId?: string;
  message?: string;
  model?: string;
  thinkingLevel?: string;
  submissionId?: string;
};

export type ModelControlState = {
  available: boolean;
  snapshot: SparkModelControlSnapshot;
  error?: string;
};

export type SubmissionState = "idle" | "submitting" | "success" | "error";

export type ComposerSurface = "start" | "session";

export type SessionsMessages = CockpitMessages["sessions"];
export type SessionsWorkbenchCopy = SessionsMessages["workbench"];
