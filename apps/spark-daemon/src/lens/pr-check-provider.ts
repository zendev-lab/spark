import { spawn } from "node:child_process";

import type { LensVerdict } from "@zendev-lab/spark-lens";

export interface GitHubPrCheck {
  name: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  link?: string;
  workflow?: string;
}

export interface GitHubPrCheckReport {
  provider: "github-pr-checks";
  verdict: LensVerdict;
  localHeadOid: string | null;
  remoteHeadOid: string | null;
  clean: boolean;
  prNumber?: number;
  url?: string;
  isDraft?: boolean;
  checks: GitHubPrCheck[];
  message: string;
  observedAt: string;
}

export type PrCheckCommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function runGitHubPrChecks(
  workspaceRoot: string,
  signal?: AbortSignal,
  commandRunner: PrCheckCommandRunner = run,
): Promise<GitHubPrCheckReport> {
  const [head, status] = await Promise.all([
    commandRunner("git", ["rev-parse", "HEAD"], workspaceRoot, signal),
    commandRunner(
      "git",
      ["status", "--porcelain", "--untracked-files=normal"],
      workspaceRoot,
      signal,
    ),
  ]);
  const localHeadOid = head.code === 0 ? head.stdout.trim() || null : null;
  const clean = status.code === 0 && status.stdout.trim() === "";
  const base = {
    provider: "github-pr-checks" as const,
    localHeadOid,
    clean,
    checks: [] as GitHubPrCheck[],
    observedAt: new Date().toISOString(),
  };
  if (!localHeadOid || status.code !== 0) {
    return {
      ...base,
      remoteHeadOid: null,
      verdict: "inconclusive",
      message: "Git workspace state is unavailable",
    };
  }

  const view = await commandRunner(
    "gh",
    ["pr", "view", "--json", "number,url,headRefOid,isDraft,state"],
    workspaceRoot,
    signal,
  );
  if (view.code !== 0) {
    return {
      ...base,
      remoteHeadOid: null,
      verdict: "inconclusive",
      message: bounded(view.stderr || view.stdout || "No pull request is associated with HEAD"),
    };
  }

  let metadata: {
    number?: unknown;
    url?: unknown;
    headRefOid?: unknown;
    isDraft?: unknown;
    state?: unknown;
  };
  try {
    metadata = JSON.parse(view.stdout) as typeof metadata;
  } catch {
    return {
      ...base,
      remoteHeadOid: null,
      verdict: "inconclusive",
      message: "GitHub returned malformed pull request metadata",
    };
  }
  const remoteHeadOid = typeof metadata.headRefOid === "string" ? metadata.headRefOid : null;
  const prNumber = typeof metadata.number === "number" ? metadata.number : undefined;
  const url = typeof metadata.url === "string" ? metadata.url : undefined;
  const isDraft = typeof metadata.isDraft === "boolean" ? metadata.isDraft : undefined;
  const state = typeof metadata.state === "string" ? metadata.state : undefined;
  const withPr = {
    ...base,
    remoteHeadOid,
    ...(prNumber === undefined ? {} : { prNumber }),
    ...(url === undefined ? {} : { url }),
    ...(isDraft === undefined ? {} : { isDraft }),
  };
  if (!clean || remoteHeadOid !== localHeadOid) {
    return {
      ...withPr,
      verdict: "stale",
      message: !clean
        ? "Worktree has uncommitted changes that are not represented by PR checks"
        : "PR checks belong to a different head commit",
    };
  }
  if (prNumber === undefined) {
    return { ...withPr, verdict: "inconclusive", message: "Pull request number is unavailable" };
  }

  const checksResult = await commandRunner(
    "gh",
    ["pr", "checks", String(prNumber), "--required", "--json", "name,state,bucket,link,workflow"],
    workspaceRoot,
    signal,
  );
  let rawChecks: unknown;
  try {
    rawChecks = JSON.parse(checksResult.stdout || "[]");
  } catch {
    return {
      ...withPr,
      verdict: "inconclusive",
      message: "GitHub returned malformed required-check data",
    };
  }
  let checks = normalizeChecks(rawChecks);
  let checkSet = "required" as "required" | "recorded";
  if (checks.length === 0 && state === "MERGED") {
    const mergedChecksResult = await commandRunner(
      "gh",
      ["pr", "checks", String(prNumber), "--json", "name,state,bucket,link,workflow"],
      workspaceRoot,
      signal,
    );
    try {
      checks = normalizeChecks(JSON.parse(mergedChecksResult.stdout || "[]"));
    } catch {
      return {
        ...withPr,
        verdict: "inconclusive",
        message: "GitHub returned malformed merged-PR check data",
      };
    }
    checkSet = "recorded";
  }
  if (checks.length === 0) {
    return {
      ...withPr,
      checks,
      verdict: "inconclusive",
      message:
        checkSet === "recorded"
          ? "No checks were recorded for the merged pull request"
          : "No required PR checks were reported",
    };
  }
  const failed = checks.some((check) => check.bucket === "fail" || check.bucket === "cancel");
  const incomplete = checks.some(
    (check) => check.bucket !== "pass" && !(checkSet === "recorded" && check.bucket === "skipping"),
  );
  const checkLabel = checkSet === "recorded" ? "merged PR checks" : "required PR checks";
  return {
    ...withPr,
    checks,
    verdict: failed ? "fail" : incomplete ? "inconclusive" : "pass",
    message: failed
      ? `One or more ${checkLabel} failed`
      : incomplete
        ? `${checkLabel[0]!.toUpperCase()}${checkLabel.slice(1)} are not complete`
        : `All ${checkLabel} completed successfully for the current head commit`,
  };
}

function normalizeChecks(value: unknown): GitHubPrCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const check = entry as Record<string, unknown>;
    if (typeof check.name !== "string" || typeof check.bucket !== "string") return [];
    if (!["pass", "fail", "pending", "skipping", "cancel"].includes(check.bucket)) return [];
    return [
      {
        name: check.name,
        state: typeof check.state === "string" ? check.state : check.bucket,
        bucket: check.bucket as GitHubPrCheck["bucket"],
        ...(typeof check.link === "string" ? { link: check.link } : {}),
        ...(typeof check.workflow === "string" ? { workflow: check.workflow } : {}),
      },
    ];
  });
}

async function run(
  command: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      signal,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const append = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error(`${command} output exceeded 2 MiB`));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function bounded(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ").slice(0, 1_000);
}
