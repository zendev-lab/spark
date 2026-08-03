import { Type } from "typebox";
import type { SparkHostAPI, ToolConfig, ToolRenderComponent } from "@zendev-lab/spark-core";
import { truncateToWidth } from "@zendev-lab/spark-text";
import {
  defaultArtifactStore,
  type Artifact,
  type ArtifactRef,
  type GitChangeArtifactBody,
} from "../artifact/index.ts";
import { GitLifecycleService, type GitLifecycleAction } from "./lifecycle.ts";

export interface GitLifecycleExtensionApi {
  registerTool(config: ToolConfig): void;
}

class ToolCallText implements ToolRenderComponent {
  private readonly text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.text, Math.max(1, width), "…")];
  }
}

const GIT_ACTIONS = [
  "inspect",
  "init",
  "checkout",
  "adopt",
  "layer_add",
  "commit",
  "refresh",
  "submit",
  "sync",
  "cleanup",
] as const satisfies readonly GitLifecycleAction[];

export function registerGitLifecycleTool(pi: GitLifecycleExtensionApi): void {
  pi.registerTool({
    name: "git",
    label: "Git",
    description:
      "Manage one git_change Artifact: its owning worktree and native GitHub PR stack lifecycle.",
    promptGuidelines: [
      "Use one git_change Artifact and one writable worktree for the complete dependent stack.",
      "gh stack is the only writable topology authority; do not emulate stack topology in Spark.",
      "submit creates drafts by default. Pass ready=true only when the stack is genuinely ready for review.",
      "Do not post routine PR comments or boilerplate about stacking/testing. Report substantive state in the task or final response.",
      "cleanup is conservative: Spark ownership, a clean worktree, remote-covered commits, and terminal PRs are all required.",
    ],
    policy: {
      effect: "destructive",
      executionMode: "sequential",
      domains: ["git", "artifact"],
      approval: "required",
    },
    resolvePolicy(args) {
      const action = normalizeGitAction(args.action);
      if (action === "inspect") {
        return {
          effect: "read",
          executionMode: "parallel",
          domains: ["git", "artifact"],
          approval: "none",
        };
      }
      if (action === "submit" || action === "sync") {
        return {
          effect: "external_write",
          executionMode: "sequential",
          domains: ["git", "artifact"],
          approval: "required",
        };
      }
      if (action === "cleanup") {
        return {
          effect: "destructive",
          executionMode: "sequential",
          domains: ["git", "artifact"],
          approval: "required",
        };
      }
      return {
        effect: "local_write",
        executionMode: "sequential",
        domains: ["git", "artifact"],
        approval: "none",
      };
    },
    parameters: Type.Object({
      action: Type.String({
        description:
          "inspect | init | checkout | adopt | layer_add | commit | refresh | submit | sync | cleanup",
      }),
      artifactRef: Type.Optional(
        Type.String({ description: "git_change Artifact ref or unambiguous prefix." }),
      ),
      title: Type.Optional(Type.String({ description: "Artifact title for init/checkout/adopt." })),
      branch: Type.Optional(Type.String({ description: "Branch for init/layer_add." })),
      trunk: Type.Optional(Type.String({ description: "Trunk branch for init." })),
      target: Type.Optional(
        Type.String({
          description: "Stack number, PR number/URL, or tracked branch for checkout.",
        }),
      ),
      worktreePath: Type.Optional(
        Type.String({ description: "Existing worktree path for inspect/adopt." }),
      ),
      message: Type.Optional(Type.String({ description: "Commit message." })),
      paths: Type.Optional(
        Type.Array(Type.String({ description: "Explicit paths to stage for commit." })),
      ),
      tracked: Type.Optional(
        Type.Boolean({ description: "Stage tracked modifications/deletions with git add -u." }),
      ),
      ready: Type.Optional(
        Type.Boolean({ description: "Submit new/existing PRs as ready instead of draft." }),
      ),
    }),
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "?";
      const target =
        typeof args.artifactRef === "string"
          ? args.artifactRef
          : typeof args.target === "string"
            ? args.target
            : undefined;
      const text = ["git", `action=${action}`, target].filter(Boolean).join(" ");
      return new ToolCallText(theme.bold ? theme.bold(text) : text);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = requireCwd(ctx);
      const store = defaultArtifactStore(cwd);
      const service = new GitLifecycleService({ cwd, store });
      const action = normalizeGitAction(params.action);

      if (action === "inspect") {
        const artifactRef =
          params.artifactRef === undefined
            ? undefined
            : await resolveGitChangeRef(store, params.artifactRef);
        const body = await service.inspect({
          artifactRef,
          worktreePath: typeof params.worktreePath === "string" ? params.worktreePath : undefined,
        });
        return gitResult(action, renderBody(body), { gitChange: body });
      }

      if (action === "init") {
        const artifact = await service.init({
          title: stringOrUndefined(params.title),
          branch: stringOrUndefined(params.branch),
          trunk: stringOrUndefined(params.trunk),
        });
        return changedResult(action, artifact);
      }

      if (action === "checkout") {
        const target = requiredString(params.target, "target");
        const artifact = await service.checkout({
          target,
          title: stringOrUndefined(params.title),
        });
        return changedResult(action, artifact);
      }

      if (action === "adopt") {
        const artifact = await service.adopt({
          worktreePath: stringOrUndefined(params.worktreePath),
          title: stringOrUndefined(params.title),
        });
        return changedResult(action, artifact);
      }

      const artifactRef = await resolveGitChangeRef(store, params.artifactRef);
      if (action === "layer_add") {
        return changedResult(
          action,
          await service.layerAdd(artifactRef, requiredString(params.branch, "branch")),
        );
      }
      if (action === "commit") {
        return changedResult(
          action,
          await service.commit({
            artifactRef,
            message: requiredString(params.message, "message"),
            paths: stringArrayOrUndefined(params.paths, "paths"),
            tracked: params.tracked === true,
          }),
        );
      }
      if (action === "refresh") {
        return changedResult(action, await service.refresh(artifactRef));
      }
      if (action === "submit") {
        return changedResult(
          action,
          await service.submit(artifactRef, { ready: params.ready === true }),
        );
      }
      if (action === "sync") {
        return changedResult(action, await service.sync(artifactRef));
      }
      return changedResult(action, await service.cleanup(artifactRef));
    },
  });
}

export function registerSparkGitLifecycleTool(pi: SparkHostAPI): void {
  if (!pi.registerTool) throw new Error("spark-artifacts git tool requires registerTool");
  registerGitLifecycleTool({ registerTool: (config) => pi.registerTool?.(config) });
}

function changedResult(action: GitLifecycleAction, artifact: Artifact<GitChangeArtifactBody>) {
  return gitResult(action, `${artifact.ref} ${artifact.title}\n${renderBody(artifact.body)}`, {
    changed: true,
    refs: { artifactRef: artifact.ref },
    artifact: {
      ref: artifact.ref,
      kind: artifact.kind,
      title: artifact.title,
      body: artifact.body,
      updatedAt: artifact.updatedAt,
    },
  });
}

function renderBody(body: GitChangeArtifactBody): string {
  return [
    `repository=${body.repository.repo}`,
    `worktree=${body.worktree.status}${body.worktree.path ? ` ${body.worktree.path}` : ""}`,
    `stack=${body.stack.authority} trunk=${body.trunk} layers=${body.stack.entries.length}`,
    `lifecycle=${body.lifecycle}`,
    ...body.stack.entries.map((entry) => {
      const pr = entry.pullRequest ? ` PR #${entry.pullRequest.number}` : "";
      return `- ${entry.branch}${pr}${entry.needsRebase ? " needs-rebase" : ""}`;
    }),
  ].join("\n");
}

function gitResult(action: GitLifecycleAction, text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    details: { tool: "git", action, ...details },
  };
}

async function resolveGitChangeRef(
  store: ReturnType<typeof defaultArtifactStore>,
  value: unknown,
): Promise<ArtifactRef> {
  if (typeof value !== "string" || !value.startsWith("artifact:")) {
    throw new Error("artifactRef must be an artifact: ref");
  }
  const requested = value as ArtifactRef;
  const exact = await store.tryGet(requested);
  if (exact) {
    if (exact.body.kind !== "git_change") throw new Error(`${exact.ref} is not git_change`);
    return exact.ref;
  }
  const matches = (await store.list({ kind: "git_change" })).filter((artifact) =>
    artifact.ref.startsWith(requested),
  );
  if (matches.length === 0) throw new Error(`git_change artifact not found: ${requested}`);
  if (matches.length > 1) {
    throw new Error(`artifactRef is ambiguous: ${requested} matches ${matches.length} artifacts`);
  }
  return matches[0]!.ref;
}

function normalizeGitAction(value: unknown): GitLifecycleAction {
  if (GIT_ACTIONS.includes(value as GitLifecycleAction)) return value as GitLifecycleAction;
  throw new Error(`git.action must be one of: ${GIT_ACTIONS.join(", ")}`);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string): string {
  const result = stringOrUndefined(value);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function stringArrayOrUndefined(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${field} must be a string array`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function requireCwd(ctx: { cwd?: string } | undefined): string {
  if (typeof ctx?.cwd !== "string" || !ctx.cwd.trim()) throw new Error("git requires ctx.cwd");
  return ctx.cwd;
}
