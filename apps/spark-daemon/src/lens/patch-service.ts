import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import {
  atomicReplaceTextFiles,
  contentVersion,
  MISSING_FILE_VERSION,
  readRegularFileSnapshot,
  type FileVersionState,
} from "@zendev-lab/spark-files";
import {
  captureWorkspaceRevision,
  createPatchProposal,
  TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
  type LensVerdict,
  type ObservationDispositionRecord,
  type ObservationRef,
  type PatchPromotion,
  type PatchProposal,
  type PatchProposalRef,
  type PatchSafety,
  type PatchTextEdit,
  type ProviderId,
  type WorkspaceRevision,
} from "@zendev-lab/spark-lens";

import { DaemonLensPatchStore } from "./patch-store.ts";

interface VerificationResult {
  verdict: LensVerdict;
  evidenceRef?: `evidence:${string}`;
}

export interface DaemonLensPatchServiceOptions {
  store: DaemonLensPatchStore;
  verifyOverlay: (input: {
    overlayRoot: string;
    revision: WorkspaceRevision;
  }) => Promise<VerificationResult>;
  verifyPromoted: (input: { workspaceRoot: string }) => Promise<VerificationResult>;
  captureRevision?: (workspaceRoot: string) => Promise<WorkspaceRevision>;
}

export class DaemonLensPatchService {
  readonly #store: DaemonLensPatchStore;
  readonly #verifyOverlay: DaemonLensPatchServiceOptions["verifyOverlay"];
  readonly #verifyPromoted: DaemonLensPatchServiceOptions["verifyPromoted"];
  readonly #captureRevision: (workspaceRoot: string) => Promise<WorkspaceRevision>;

  constructor(options: DaemonLensPatchServiceOptions) {
    this.#store = options.store;
    this.#verifyOverlay = options.verifyOverlay;
    this.#verifyPromoted = options.verifyPromoted;
    this.#captureRevision =
      options.captureRevision ??
      (async (workspaceRoot) => {
        return await captureWorkspaceRevision({
          workspaceRoot,
          profile: TYPESCRIPT_DUAL_VERIFICATION_PROFILE,
        });
      });
  }

  async propose(input: {
    workspaceRoot: string;
    provider: ProviderId;
    edits: readonly PatchTextEdit[];
    expectedResolution?: readonly ObservationRef[];
    safety?: PatchSafety;
  }): Promise<PatchProposal> {
    const baseRevision = await this.#captureRevision(input.workspaceRoot);
    const preconditions = await preconditionsForEdits(input.workspaceRoot, input.edits);
    const automaticReasons = preconditions.some(
      (precondition) => precondition.expectedVersion === MISSING_FILE_VERSION,
    )
      ? (["create_delete"] as const)
      : [];
    const requestedReasons =
      input.safety?.kind === "requires_selection" ? input.safety.reasons : [];
    const reasons = [...new Set([...automaticReasons, ...requestedReasons])];
    const proposal = createPatchProposal({
      baseRevision,
      provider: input.provider,
      edits: input.edits,
      preconditions,
      expectedResolution: input.expectedResolution ?? [],
      safety: reasons.length > 0 ? { kind: "requires_selection", reasons } : { kind: "safe" },
      createdAt: new Date().toISOString(),
    });
    this.#store.save(input.workspaceRoot, proposal);
    return proposal;
  }

  async apply(input: {
    workspaceRoot: string;
    proposalRef: PatchProposalRef;
    explicitSelection?: boolean;
    signal?: AbortSignal;
  }): Promise<PatchPromotion> {
    const stored = this.#store.load(input.proposalRef);
    if (!stored) throw new Error(`unknown Lens patch proposal: ${input.proposalRef}`);
    if (stored.status !== "proposed") {
      throw new Error(`Lens patch proposal is not applicable: ${stored.status}`);
    }
    const proposal = stored.proposal;
    if (proposal.baseRevision.workspaceRoot !== resolve(input.workspaceRoot)) {
      throw new Error("Lens patch proposal belongs to another worktree");
    }
    if (proposal.safety.kind === "requires_selection" && input.explicitSelection !== true) {
      throw new Error(
        `Lens patch proposal requires explicit selection: ${proposal.safety.reasons.join(", ")}`,
      );
    }
    const current = await this.#captureRevision(input.workspaceRoot);
    if (current.digest !== proposal.baseRevision.digest) {
      this.#store.setStatus(proposal.ref, "stale");
      throw new Error("Lens patch proposal base revision is stale");
    }

    const patchedFiles = await renderPatchedFiles(input.workspaceRoot, proposal);
    const overlayRoot = await materializeOverlay(input.workspaceRoot, patchedFiles);
    try {
      const overlayRevision = syntheticOverlayRevision(
        proposal.baseRevision,
        overlayRoot,
        proposal.ref,
      );
      const overlay = await this.#verifyOverlay({ overlayRoot, revision: overlayRevision });
      if (overlay.verdict !== "pass") {
        throw new Error(`Lens patch overlay verification did not pass: ${overlay.verdict}`);
      }
    } finally {
      await rm(overlayRoot, { recursive: true, force: true });
    }

    const beforePromotion = await this.#captureRevision(input.workspaceRoot);
    if (beforePromotion.digest !== proposal.baseRevision.digest) {
      this.#store.setStatus(proposal.ref, "stale");
      throw new Error("Lens patch proposal became stale before promotion");
    }
    const promoted = await atomicReplaceTextFiles(
      patchedFiles.map((file) => ({
        filePath: resolve(input.workspaceRoot, file.path),
        content: file.content,
        expectedVersion: file.expectedVersion,
      })),
      { signal: input.signal },
    );
    if (!promoted.ok) {
      this.#store.setStatus(proposal.ref, "stale");
      throw new Error(
        `Lens patch proposal lost file CAS for ${promoted.filePath}: expected ${promoted.expectedVersion}, actual ${promoted.actualVersion}`,
      );
    }

    this.#store.setStatus(proposal.ref, "applied");
    const promotedRevision = await this.#captureRevision(input.workspaceRoot);
    const verification = await this.#verifyPromoted({ workspaceRoot: input.workspaceRoot });
    return {
      proposalRef: proposal.ref,
      baseRevisionDigest: proposal.baseRevision.digest,
      promotedRevision,
      ...(verification.evidenceRef ? { verificationEvidenceRef: verification.evidenceRef } : {}),
      verdict: verification.verdict,
      appliedAt: new Date().toISOString(),
    };
  }

  triage(
    workspaceRoot: string,
    input: Omit<ObservationDispositionRecord, "updatedAt">,
  ): ObservationDispositionRecord {
    if (input.disposition === "suppressed") {
      if (!input.patchProposalRef) {
        throw new Error("suppressed disposition requires an applied Patch Proposal");
      }
      const patch = this.#store.load(input.patchProposalRef);
      if (patch?.status !== "applied") {
        throw new Error("suppressed disposition requires an applied Patch Proposal");
      }
    }
    const record = { ...input, updatedAt: new Date().toISOString() };
    this.#store.saveDisposition(workspaceRoot, record);
    return record;
  }
}

async function preconditionsForEdits(
  workspaceRoot: string,
  edits: readonly PatchTextEdit[],
): Promise<{ path: string; expectedVersion: FileVersionState }[]> {
  const paths = [...new Set(edits.map((edit) => edit.path))].sort();
  return await Promise.all(
    paths.map(async (path) => {
      const absolutePath = workspacePath(workspaceRoot, path);
      try {
        const snapshot = await readRegularFileSnapshot(absolutePath);
        return { path, expectedVersion: snapshot.version };
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return { path, expectedVersion: MISSING_FILE_VERSION };
        }
        throw error;
      }
    }),
  );
}

async function renderPatchedFiles(
  workspaceRoot: string,
  proposal: PatchProposal,
): Promise<{ path: string; expectedVersion: FileVersionState; content: string }[]> {
  const preconditions = new Map(
    proposal.preconditions.map((precondition) => [precondition.path, precondition.expectedVersion]),
  );
  const editsByPath = new Map<string, PatchTextEdit[]>();
  for (const edit of proposal.edits) {
    const group = editsByPath.get(edit.path);
    if (group) group.push(edit);
    else editsByPath.set(edit.path, [edit]);
  }
  const files = [];
  for (const [path, edits] of [...editsByPath].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const expectedVersion = preconditions.get(path);
    if (!expectedVersion) throw new Error(`patch proposal lacks precondition for ${path}`);
    const absolutePath = workspacePath(workspaceRoot, path);
    const source =
      expectedVersion === MISSING_FILE_VERSION ? "" : await readFile(absolutePath, "utf8");
    const actualVersion =
      expectedVersion === MISSING_FILE_VERSION
        ? MISSING_FILE_VERSION
        : contentVersion(Buffer.from(source, "utf8"));
    if (actualVersion !== expectedVersion) {
      throw new Error(`patch proposal file precondition is stale for ${path}`);
    }
    let content = source;
    for (const edit of [...edits].sort((left, right) => right.startOffset - left.startOffset)) {
      if (edit.endOffset > content.length) {
        throw new Error(`patch edit range exceeds ${path}`);
      }
      content = `${content.slice(0, edit.startOffset)}${edit.newText}${content.slice(edit.endOffset)}`;
    }
    files.push({ path, expectedVersion, content });
  }
  return files;
}

async function materializeOverlay(
  workspaceRoot: string,
  files: readonly { path: string; content: string }[],
): Promise<string> {
  const sourceRoot = resolve(workspaceRoot);
  const overlayRoot = await mkdtemp(resolve(tmpdir(), "spark-lens-overlay-"));
  await cp(sourceRoot, overlayRoot, {
    recursive: true,
    filter(source) {
      const path = relative(sourceRoot, source).replaceAll("\\", "/");
      if (!path) return true;
      const parts = path.split("/");
      if (parts.includes(".git") || parts.includes(".spark")) return false;
      return path !== "node_modules";
    },
  });
  try {
    await lstat(resolve(sourceRoot, "node_modules"));
    await symlink(resolve(sourceRoot, "node_modules"), resolve(overlayRoot, "node_modules"));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  for (const file of files) {
    const destination = workspacePath(overlayRoot, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
  }
  return overlayRoot;
}

function syntheticOverlayRevision(
  base: WorkspaceRevision,
  overlayRoot: string,
  proposalRef: PatchProposalRef,
): WorkspaceRevision {
  return {
    ...base,
    workspaceRoot: overlayRoot,
    digest: createHash("sha256").update(`${base.digest}\0${proposalRef}\0overlay`).digest("hex"),
    observedAt: new Date().toISOString(),
  };
}

function workspacePath(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, path);
  const relation = relative(root, absolute);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`patch path escapes workspace: ${path}`);
  }
  return absolute;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
