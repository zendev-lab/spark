import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  captureWorkspaceRevision,
  TSC_PROVIDER_ID,
  TYPESCRIPT_DUAL_ROUTE_DIGEST,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  VITE_PLUS_PROVIDER_ID,
  type LensVerificationReceipt,
} from "@zendev-lab/spark-lens";
import type { ArtifactRef } from "../artifact/index.ts";

type LensEvidenceRef = `evidence:${string}`;

export async function requireCurrentLensPass(
  worktreePath: string,
  gitChangeRef: ArtifactRef,
): Promise<LensEvidenceRef> {
  const candidates = (await readLensEvidence(worktreePath)).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  const current = await captureWorkspaceRevision({
    workspaceRoot: worktreePath,
    profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  });

  for (const candidate of candidates) {
    const receipt = parseLensReceipt(candidate.body);
    if (!receipt) continue;
    if (
      receipt.gitChangeRef === gitChangeRef &&
      receipt.verdict === "pass" &&
      receipt.workspaceRevision.digest === current.digest &&
      receipt.routeDigest === TYPESCRIPT_DUAL_ROUTE_DIGEST &&
      receipt.profileDigest === current.profileDigest &&
      requiredProvidersPassed(receipt)
    ) {
      return candidate.ref;
    }
  }
  throw new Error(
    `current Pass Lens receipt required for ${gitChangeRef}; run lens({ action: "verify", artifactRef: "${gitChangeRef}" })`,
  );
}

async function readLensEvidence(worktreePath: string): Promise<
  Array<{
    ref: LensEvidenceRef;
    body: unknown;
    updatedAt: string;
  }>
> {
  const root = join(worktreePath, ".spark", "evidence");
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const metadata = JSON.parse(await readFile(join(root, name), "utf8")) as {
            ref?: unknown;
            kind?: unknown;
            format?: unknown;
            body?: unknown;
            bodyTruncated?: unknown;
            blobPath?: unknown;
            provenance?: { note?: unknown };
            updatedAt?: unknown;
          };
          if (
            typeof metadata.ref !== "string" ||
            !metadata.ref.startsWith("evidence:") ||
            metadata.kind !== "record" ||
            metadata.format !== "json" ||
            metadata.provenance?.note !== "lens:typescript-dual-verification-v1" ||
            typeof metadata.updatedAt !== "string"
          ) {
            return undefined;
          }
          let body = metadata.body;
          if (metadata.bodyTruncated === true) {
            if (typeof metadata.blobPath !== "string") return undefined;
            body = JSON.parse(await readFile(join(root, metadata.blobPath), "utf8"));
          }
          return {
            ref: metadata.ref as LensEvidenceRef,
            body,
            updatedAt: metadata.updatedAt,
          };
        } catch {
          return undefined;
        }
      }),
  );
  return records.filter((record): record is NonNullable<typeof record> => record !== undefined);
}

function parseLensReceipt(value: unknown): LensVerificationReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const receipt = value as Partial<LensVerificationReceipt>;
  if (
    receipt.schemaVersion !== 1 ||
    typeof receipt.workspaceRevision?.digest !== "string" ||
    typeof receipt.routeDigest !== "string" ||
    typeof receipt.profileDigest !== "string" ||
    !Array.isArray(receipt.providers) ||
    !Array.isArray(receipt.obligations) ||
    !Array.isArray(receipt.observationRefs) ||
    !["pass", "fail", "inconclusive", "stale"].includes(receipt.verdict ?? "")
  ) {
    return undefined;
  }
  return receipt as LensVerificationReceipt;
}

function requiredProvidersPassed(receipt: LensVerificationReceipt): boolean {
  const passed = new Set(
    receipt.providers.filter((provider) => provider.status === "ok").map((provider) => provider.id),
  );
  return passed.has(TSC_PROVIDER_ID) && passed.has(VITE_PLUS_PROVIDER_ID);
}
