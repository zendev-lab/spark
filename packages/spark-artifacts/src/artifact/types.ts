/** User-facing Artifact kinds only. Internal evidence uses document|record|trace|knowledge. */
export type ArtifactKind = "issue" | "pr" | "preview";

export const ARTIFACT_KINDS = ["issue", "pr", "preview"] as const satisfies readonly ArtifactKind[];

export type ArtifactRef = `artifact:${string}` & { readonly __artifact?: "artifact" };

export type ForgeHost = "github" | "gitlab";

export type ArtifactFormat = "json" | "markdown" | "mdx" | "html" | "text";

export const ARTIFACT_FORMATS = [
  "json",
  "markdown",
  "mdx",
  "html",
  "text",
] as const satisfies readonly ArtifactFormat[];

export type PreviewContentFormat = "md" | "mdx" | "html" | "a2ui" | "spark-ui";

export interface PreviewProgress {
  label?: string;
  percent?: number;
  stage?: string;
}

export interface IssueArtifactBody {
  schemaVersion: 1;
  kind: "issue";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
}

export type WorktreeStatus = "attached" | "failed" | "missing" | "removed";

export interface PrArtifactBody {
  schemaVersion: 1;
  kind: "pr";
  forge: ForgeHost;
  repo: string;
  number: number;
  url: string;
  state: string;
  title: string;
  labels?: string[];
  syncedAt?: string;
  bodyText?: string;
  headRef: string;
  baseRef: string;
  draft?: boolean;
  checksSummary?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeStatus?: WorktreeStatus;
  worktreeError?: string;
  diffSummary?: string;
}

export interface PreviewArtifactBody {
  schemaVersion: 1;
  kind: "preview";
  format: PreviewContentFormat;
  content: string;
  version: number;
  progress?: PreviewProgress;
}

export type ArtifactBody = IssueArtifactBody | PrArtifactBody | PreviewArtifactBody;

export interface Artifact<T extends ArtifactBody = ArtifactBody> {
  ref: ArtifactRef;
  kind: ArtifactKind;
  title: string;
  format: ArtifactFormat;
  body: T;
  hash?: string;
  blobPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PutArtifactInput<T extends ArtifactBody = ArtifactBody> {
  kind: ArtifactKind;
  title: string;
  format?: ArtifactFormat;
  body: T;
  ref?: ArtifactRef;
}

export interface ArtifactQuery {
  kind?: ArtifactKind;
}

export interface ArtifactStoreOptions {
  rootDir: string;
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return ARTIFACT_KINDS.includes(value as ArtifactKind);
}

export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return ARTIFACT_FORMATS.includes(value as ArtifactFormat);
}

export function isArtifactBody(value: unknown): value is ArtifactBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) return false;
  if (record.kind === "issue" || record.kind === "pr") {
    return (
      (record.forge === "github" || record.forge === "gitlab") &&
      typeof record.repo === "string" &&
      typeof record.number === "number" &&
      typeof record.url === "string" &&
      typeof record.state === "string" &&
      typeof record.title === "string" &&
      (record.kind === "issue" ||
        (typeof record.headRef === "string" && typeof record.baseRef === "string"))
    );
  }
  if (record.kind === "preview") {
    return (
      (record.format === "md" ||
        record.format === "mdx" ||
        record.format === "html" ||
        record.format === "a2ui" ||
        record.format === "spark-ui") &&
      typeof record.content === "string" &&
      typeof record.version === "number"
    );
  }
  return false;
}

export function asJsonValue(body: ArtifactBody): Record<string, unknown> {
  return body as unknown as Record<string, unknown>;
}
