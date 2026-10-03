import { createHash } from "node:crypto";

interface LensDocumentSnapshot {
  worktreeRoot: string;
  uri: string;
  languageId: string;
  version: number;
  content: string;
  contentHash: string;
}

export class DaemonLensDocumentMirrors {
  readonly #worktrees = new Map<string, Map<string, LensDocumentSnapshot>>();

  sync(input: {
    worktreeRoot: string;
    uri: string;
    languageId: string;
    version: number;
    content: string;
  }): LensDocumentSnapshot {
    const documents = this.#worktrees.get(input.worktreeRoot) ?? new Map();
    const previous = documents.get(input.uri);
    if (previous && input.version <= previous.version) {
      throw new Error(
        `stale document version for ${input.uri}: ${input.version} <= ${previous.version}`,
      );
    }
    const snapshot: LensDocumentSnapshot = {
      ...input,
      contentHash: createHash("sha256").update(input.content).digest("hex"),
    };
    documents.set(input.uri, snapshot);
    this.#worktrees.set(input.worktreeRoot, documents);
    return snapshot;
  }

  get(worktreeRoot: string, uri: string): LensDocumentSnapshot | undefined {
    return this.#worktrees.get(worktreeRoot)?.get(uri);
  }

  close(worktreeRoot: string, uri: string): boolean {
    const documents = this.#worktrees.get(worktreeRoot);
    if (!documents) return false;
    const deleted = documents.delete(uri);
    if (documents.size === 0) this.#worktrees.delete(worktreeRoot);
    return deleted;
  }

  clearWorktree(worktreeRoot: string): void {
    this.#worktrees.delete(worktreeRoot);
  }
}
