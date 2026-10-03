import { readFile } from "node:fs/promises";

import { writeJsonFileAtomic } from "@zendev-lab/spark-platform-node/json-files";
import type { SparkMemoryApprovalProof } from "@zendev-lab/spark-protocol";

import { memoryContentDigest } from "./lifecycle.ts";
import { withFileMutationLock } from "./mutation-lock.ts";

interface MemoryApprovalConsumption {
  proofRef: string;
  transactionId: string;
  proofDigest: string;
  status: "reserved" | "committed";
  reservedAt: string;
  committedAt?: string;
}

interface MemoryApprovalConsumptionSnapshot {
  version: 2;
  consumptions: MemoryApprovalConsumption[];
}

export type MemoryApprovalProofReservation = "reserved" | "committed";

export type MemoryApprovalProofReserver = (
  proof: SparkMemoryApprovalProof,
  transactionId: string,
  allowCreate: boolean,
) => Promise<MemoryApprovalProofReservation | false>;

export type MemoryApprovalProofCommitter = (
  proof: SparkMemoryApprovalProof,
  transactionId: string,
) => Promise<boolean>;

export function createFileMemoryApprovalProofReserver(
  filePath: string,
  options: { now?: () => string } = {},
): MemoryApprovalProofReserver {
  const now = options.now ?? (() => new Date().toISOString());
  return async (proof, transactionId, allowCreate) =>
    withFileMutationLock(`${filePath}.lock`, async () => {
      const snapshot = await loadConsumptionSnapshot(filePath);
      const proofDigest = memoryContentDigest(proof);
      const priorProof = snapshot.consumptions.find((entry) => entry.proofRef === proof.proofRef);
      if (priorProof) {
        return priorProof.transactionId === transactionId && priorProof.proofDigest === proofDigest
          ? priorProof.status
          : false;
      }
      if (!allowCreate) return false;
      if (snapshot.consumptions.some((entry) => entry.transactionId === transactionId))
        return false;
      snapshot.consumptions.push({
        proofRef: proof.proofRef,
        transactionId,
        proofDigest,
        status: "reserved",
        reservedAt: now(),
      });
      snapshot.consumptions.sort(compareConsumptions);
      await writeJsonFileAtomic(filePath, snapshot);
      return "reserved";
    });
}

export function createFileMemoryApprovalProofCommitter(
  filePath: string,
  options: { now?: () => string } = {},
): MemoryApprovalProofCommitter {
  const now = options.now ?? (() => new Date().toISOString());
  return async (proof, transactionId) =>
    withFileMutationLock(`${filePath}.lock`, async () => {
      const snapshot = await loadConsumptionSnapshot(filePath);
      const proofDigest = memoryContentDigest(proof);
      const entry = snapshot.consumptions.find(
        (candidate) => candidate.proofRef === proof.proofRef,
      );
      if (!entry) return false;
      if (entry.transactionId !== transactionId || entry.proofDigest !== proofDigest) return false;
      if (entry.status === "committed") return true;
      entry.status = "committed";
      entry.committedAt = now();
      snapshot.consumptions.sort(compareConsumptions);
      await writeJsonFileAtomic(filePath, snapshot);
      return true;
    });
}

async function loadConsumptionSnapshot(
  filePath: string,
): Promise<MemoryApprovalConsumptionSnapshot> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, consumptions: [] };
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`invalid memory approval consumption ledger: ${filePath}`);
  }
  const snapshot = parsed as {
    version?: unknown;
    consumptions?: unknown;
  };
  if ((snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.consumptions)) {
    throw new Error(`invalid memory approval consumption ledger: ${filePath}`);
  }
  const consumptions = snapshot.consumptions.map((entry, index) =>
    normalizeConsumption(entry, filePath, index, snapshot.version === 1),
  );
  const proofRefs = new Set<string>();
  const transactionIds = new Set<string>();
  for (const entry of consumptions) {
    if (proofRefs.has(entry.proofRef) || transactionIds.has(entry.transactionId)) {
      throw new Error(
        `invalid memory approval consumption ledger: duplicate binding in ${filePath}`,
      );
    }
    proofRefs.add(entry.proofRef);
    transactionIds.add(entry.transactionId);
  }
  return { version: 2, consumptions };
}

function normalizeConsumption(
  value: unknown,
  filePath: string,
  index: number,
  legacy: boolean,
): MemoryApprovalConsumption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid memory approval consumption ledger: ${filePath} entry ${index}`);
  }
  const entry = value as Partial<MemoryApprovalConsumption> & { consumedAt?: unknown };
  const reservedAt = entry.reservedAt ?? entry.consumedAt;
  const status = legacy ? "committed" : entry.status;
  if (
    typeof entry.proofRef !== "string" ||
    !entry.proofRef.trim() ||
    typeof entry.transactionId !== "string" ||
    !entry.transactionId.trim() ||
    typeof entry.proofDigest !== "string" ||
    !/^[\da-f]{64}$/u.test(entry.proofDigest) ||
    (status !== "reserved" && status !== "committed") ||
    typeof reservedAt !== "string" ||
    Number.isNaN(Date.parse(reservedAt)) ||
    (entry.committedAt !== undefined &&
      (typeof entry.committedAt !== "string" || Number.isNaN(Date.parse(entry.committedAt))))
  ) {
    throw new Error(`invalid memory approval consumption ledger: ${filePath} entry ${index}`);
  }
  return {
    proofRef: entry.proofRef,
    transactionId: entry.transactionId,
    proofDigest: entry.proofDigest,
    status,
    reservedAt,
    ...(status === "committed"
      ? { committedAt: typeof entry.committedAt === "string" ? entry.committedAt : reservedAt }
      : {}),
  };
}

function compareConsumptions(
  left: MemoryApprovalConsumption,
  right: MemoryApprovalConsumption,
): number {
  return left.proofRef < right.proofRef ? -1 : left.proofRef > right.proofRef ? 1 : 0;
}
