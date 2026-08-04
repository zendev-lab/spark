import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { SparkLoopConditionReceipt } from "@zendev-lab/spark-protocol";
import type {
  SparkTrustedLoopEvaluator,
  SparkTrustedLoopEvaluatorResult,
} from "../store/loop-evaluators.ts";

export const GITHUB_MERGED_PRS_LOOP_EVALUATOR = "extension:github-merged-prs" as const;

interface GitHubMergedPullRequest {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  mergedAt: string;
  url: string;
}

interface GitHubMergedPrState {
  version: 1;
  repository: string;
  seenMergedPrs: number[];
  updatedAt: string;
}

interface GitHubMergedPrEvaluatorOptions {
  stateRoot: string;
  queryMergedPullRequests?: (
    repository: string,
    signal?: AbortSignal,
  ) => Promise<GitHubMergedPullRequest[]>;
  now?: () => string;
}

/**
 * A fixed-semantics trusted evaluator for GitHub merge-event Workflows.
 *
 * It never evaluates a caller-supplied command. `detect` directly invokes the
 * GitHub CLI with a validated owner/repository argument and records a durable
 * baseline. `ack` advances that baseline only from the current Cycle's trusted
 * before_tick receipt, so a failed main tick cannot lose an event.
 */
export function createGitHubMergedPrsLoopEvaluator(
  options: GitHubMergedPrEvaluatorOptions,
): SparkTrustedLoopEvaluator {
  const query = options.queryMergedPullRequests ?? queryMergedPullRequests;
  const now = options.now ?? (() => new Date().toISOString());
  return async (context, signal) => {
    const input = githubMergedPrInput(context.input);
    const statePath = githubMergedPrStatePath(
      options.stateRoot,
      context.loop.loopId,
      input.repository,
    );
    if (input.operation === "ack") {
      return await acknowledgeMergedPrs({
        repository: input.repository,
        statePath,
        receipts: context.checkpoint.receipts,
        now: now(),
      });
    }

    const merged = await query(input.repository, signal);
    const currentNumbers = uniqueSortedNumbers(merged.map((pullRequest) => pullRequest.number));
    const existing = await readGitHubMergedPrState(statePath, input.repository);
    if (!existing) {
      await writeGitHubMergedPrState(statePath, {
        version: 1,
        repository: input.repository,
        seenMergedPrs: currentNumbers,
        updatedAt: now(),
      });
      return {
        verdict: "matched",
        reason: `initialized GitHub merge baseline for ${input.repository}; no main tick required`,
        inputSummary: {
          operation: "detect",
          repository: input.repository,
          baselineInitialized: true,
          pendingMergedPrs: [],
          currentMergedPrNumbers: currentNumbers,
        },
      };
    }

    const seen = new Set(existing.seenMergedPrs);
    const pending = merged.filter((pullRequest) => !seen.has(pullRequest.number));
    return {
      verdict: pending.length === 0 ? "matched" : "not_matched",
      reason:
        pending.length === 0
          ? `no newly merged pull requests in ${input.repository}; no main tick required`
          : `${pending.length} newly merged pull request(s) detected in ${input.repository}`,
      inputSummary: {
        operation: "detect",
        repository: input.repository,
        baselineInitialized: false,
        pendingMergedPrs: pending,
        currentMergedPrNumbers: currentNumbers,
      },
    };
  };
}

async function acknowledgeMergedPrs(input: {
  repository: string;
  statePath: string;
  receipts: SparkLoopConditionReceipt[];
  now: string;
}): Promise<SparkTrustedLoopEvaluatorResult> {
  const detection = [...input.receipts]
    .reverse()
    .find(
      (receipt) =>
        receipt.checkpoint === "before_tick" &&
        receipt.selector === GITHUB_MERGED_PRS_LOOP_EVALUATOR &&
        receipt.inputSummary.operation === "detect" &&
        receipt.inputSummary.repository === input.repository,
    );
  if (!detection) {
    throw new Error(`GitHub merge acknowledgement has no matching before_tick receipt`);
  }
  const pending = githubMergedPrList(detection.inputSummary.pendingMergedPrs, "pendingMergedPrs");
  if (pending.length === 0) {
    throw new Error(`GitHub merge acknowledgement has no pending pull requests`);
  }
  const currentNumbers = numberList(
    detection.inputSummary.currentMergedPrNumbers,
    "currentMergedPrNumbers",
  );
  await writeGitHubMergedPrState(input.statePath, {
    version: 1,
    repository: input.repository,
    seenMergedPrs: uniqueSortedNumbers(currentNumbers),
    updatedAt: input.now,
  });
  return {
    verdict: "matched",
    reason: `acknowledged ${pending.length} merged pull request(s) after a successful main tick`,
    inputSummary: {
      operation: "ack",
      repository: input.repository,
      acknowledgedMergedPrNumbers: pending.map((pullRequest) => pullRequest.number),
    },
  };
}

function githubMergedPrInput(input: Record<string, unknown>): {
  operation: "detect" | "ack";
  repository: string;
} {
  const operation = input.operation;
  if (operation !== "detect" && operation !== "ack") {
    throw new Error(`GitHub merge evaluator operation must be detect or ack`);
  }
  const repository = typeof input.repository === "string" ? input.repository.trim() : "";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`GitHub merge evaluator repository must be owner/name`);
  }
  return { operation, repository };
}

async function queryMergedPullRequests(
  repository: string,
  signal?: AbortSignal,
): Promise<GitHubMergedPullRequest[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repository,
        "--state",
        "merged",
        "--limit",
        "1000",
        "--json",
        "number,title,headRefName,baseRefName,mergedAt,url",
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000, signal },
      (error, value) => {
        if (error) reject(error);
        else resolve(value);
      },
    );
  });
  return githubMergedPrList(JSON.parse(stdout) as unknown, "GitHub CLI output");
}

function githubMergedPrList(value: unknown, label: string): GitHubMergedPullRequest[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const number = record.number;
    if (!Number.isSafeInteger(number) || Number(number) <= 0) {
      throw new Error(`${label}[${index}].number must be a positive integer`);
    }
    return {
      number: Number(number),
      title: requiredString(record.title, `${label}[${index}].title`),
      headRefName: requiredString(record.headRefName, `${label}[${index}].headRefName`),
      baseRefName: requiredString(record.baseRefName, `${label}[${index}].baseRefName`),
      mergedAt: requiredString(record.mergedAt, `${label}[${index}].mergedAt`),
      url: requiredString(record.url, `${label}[${index}].url`),
    };
  });
}

function numberList(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!Number.isSafeInteger(entry) || Number(entry) <= 0) {
      throw new Error(`${label}[${index}] must be a positive integer`);
    }
    return Number(entry);
  });
}

async function readGitHubMergedPrState(
  path: string,
  repository: string,
): Promise<GitHubMergedPrState | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`GitHub merge evaluator state must be an object`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || record.repository !== repository) {
    throw new Error(`GitHub merge evaluator state identity mismatch`);
  }
  return {
    version: 1,
    repository,
    seenMergedPrs: uniqueSortedNumbers(numberList(record.seenMergedPrs, "seenMergedPrs")),
    updatedAt: requiredString(record.updatedAt, "updatedAt"),
  };
}

async function writeGitHubMergedPrState(path: string, state: GitHubMergedPrState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function githubMergedPrStatePath(stateRoot: string, loopId: string, repository: string): string {
  const digest = createHash("sha256").update(`${loopId}\0${repository}`).digest("hex");
  return join(stateRoot, "loop-evaluators", "github-merged-prs", `${digest}.json`);
}

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a string`);
  return value;
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
