# @zendev-lab/spark-files

Working-tree file tools for Spark-native extension hosts: `read`, `write`,
`edit`, `grep`, and `find`. These give a Spark host a stable coding-agent file
surface without depending on pi-coding-agent; the implementation depends only
on `@zendev-lab/spark-core`, `typebox`, `diff`, `ignore`, and `minimatch` — no
`@earendil-works/pi-coding-agent` runtime, no `@earendil-works/pi-tui`, and no
`rg`/`fd`/`bash` subprocess.

## Tools

- `read` — read a text file with 1-indexed `offset`/`limit` or by `page`.
  Without any window args the read returns the **last page** so long files
  surface their tail; a page holds up to 512 lines/16KB (whichever is hit
  first) with an actionable continuation notice (`Use offset=… to continue`).
  `maxBytes`/`maxLines`/`page` override the defaults for a single call. It
  has one output format: the raw-byte SHA-256 version followed by stable
  `LINE#HASH:text` anchors. Structured details carry the same version,
  window, page, and maxBytes/maxLines metadata. LF, CRLF,
  CR-only, mixed endings, and a UTF-8 BOM are reported as metadata while the
  visible anchors use logical line text. Invalid UTF-8 fails explicitly.
  Pagination values must be positive integers. `expectedVersion` can bind a
  paginated read to an earlier snapshot. Daemon hosts enrich reads with
  version-matched Lens context by default (`analysis: auto | fresh | off`).
  Ordinary reads never mutate files. An explicit `repair: format |
  safe_fixes | format_and_safe_fixes` refines the call into a sequential write:
  a fixed Provider produces a single-file Patch Proposal, verifies it in an
  overlay, promotes it through Files CAS, and returns the final source and
  version. Conflicts, incomplete Providers, unsafe or ambiguous edits, and
  failed verification leave the original content in place.
- `write` — atomically create or overwrite a file through a same-directory
  temporary file, preserving an existing file's mode. `expectedVersion` is
  required: pass the version returned by `read` to replace that exact snapshot,
  or `missing` for create-only intent. Missing, malformed, and stale
  preconditions fail without replacing the target. Writes are serialized by
  canonical target path inside the Spark process, including symlinked parent
  aliases, so concurrent Spark writes using the same version have one winner.
  A direct symbolic-link target is rejected instead of silently replacing the
  link.
- `edit` — exact-then-fuzzy multi-edit replacement. Each `edits[].oldText`
  matches the original content; overlapping, duplicate, empty, and
  no-op edits are rejected with precise errors. Its read/commit window uses the
  same atomic version check, so an intervening change fails instead of being
  overwritten. Emits a display diff plus a unified patch in `details`.
- `grep` — pure-JS content search returning `path:line: text`, with regex or
  literal matching, optional case-insensitivity, optional context lines, glob
  filtering, and match/byte/line truncation. Respects `.gitignore` plus hard
  `node_modules` / `.git` ignores.
- `find` — pure-JS glob file search over a gitignore-aware walk.

`bash` is intentionally omitted: Spark uses `cue_exec` for shell execution and
spark-cue disables bash by policy.

## DSH adapter

The `@zendev-lab/spark-files/dsh` entry registers DSH-native `read`, `write`,
and `edit` definitions over the host's `ctx.fs` provider. It does not call the
Spark/Pi `ToolConfig` executors or access Node's filesystem behind DSH. Every
mutation passes the session's resolved `SandboxExecutionPolicy` to the
provider, so workspace confinement remains enforced at the filesystem seam.

The DSH surface keeps the Spark versioned workflow but uses the provider's
opaque `FsVersion`, not the native host's content SHA-256. `read` returns that
token with the same `LINE#HASH:text` anchors; `write` requires the token or
`missing`, and `edit` requires the token plus one or more non-overlapping
replacements. The provider enforces the final atomic CAS. These schemas do not
advertise sandbox escalation fields and do not own an approval path.

`spark-web-dsh` mounts this adapter only inside its managed Spark presets. The
official DSH file-tool plugin remains globally mounted for `read_image`; the
scoped Spark definitions shadow only its text `read`/`write`/`edit` tools.
Artifact-root routing, Lens analysis, and repair remain native Spark semantics
and are not reproduced in the DSH adapter.

## Usage

```ts
import piFilesExtension, { registerSparkFilesTools } from "@zendev-lab/spark-files";

// As a default Spark-native extension factory:
piFilesExtension(pi);

// Or register a subset:
registerSparkFilesTools(pi, { tools: ["read", "grep", "find"] });
```

Tools resolve their working directory from the extension context (`ctx.cwd`)
per call. Supplying a `git_change` `artifactRef` routes relative paths to that
Artifact's attached worktree; absolute paths remain absolute. This is routing
and attribution, not a permission boundary. `ls` remains exported only for
explicit compatibility registration and is not part of the default tool set.

## Pi product compatibility

The published Pi compatibility manifest does not register Spark replacements
for `read`, `write`, `edit`, `grep`, `find`, or `ls`. External Pi keeps its
native file and search tools authoritative.

Replacing those built-ins coupled ordinary file access to Spark daemon,
session, workspace-cwd, protocol-version, and process-lifecycle compatibility
without adding enough product value. The resulting failure domain was larger
than the benefit, so this compatibility surface is intentionally removed rather
than maintained as a second file-tool product.

`daemon-extension.ts` remains only as a bounded migration and integration-test
adapter. It is not a supported Pi product surface and receives no new
Pi-specific behavior. See
[`.agents/notes/contracts/pi-product-compatibility.md`](../../.agents/notes/contracts/pi-product-compatibility.md).

The sole Spark read/write protocol is versioned: there is no plain read mode and
no blind write path. The check is content-level optimistic concurrency plus a
process-local per-path lock, not a cross-process filesystem transaction or a
Graft scratch graph. A non-cooperating external writer can still race the final
check. Atomic replacement creates a new inode: if the old file has sibling hard
links, those other names continue to reference the old inode and content. Graft
daemon, candidate, patch, and promotion semantics remain owned by the
separately opt-in `@zendev-lab/spark-graft` package.
