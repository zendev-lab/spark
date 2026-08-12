import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const fixedGitCandidates = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];
const fixedGhCandidates = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];
const fixedLaunchctl = "/bin/launchctl";

export interface FrozenExecutableIdentity {
  path: string;
  device: number;
  inode: number;
  size: number;
  sha256: string;
}

// Module loading is part of host bootstrap. Freeze an installed extension
// before any model turn can edit user-owned files; a later install requires a
// host restart before it becomes available to Spark.
const frozenGitHubStackCommand = freezeGitHubStackCommand();

export function gitCommand(): string {
  for (const candidate of fixedGitCandidates) {
    const trusted = trustedSystemExecutable(candidate);
    if (trusted) return trusted;
  }

  throw new Error("Spark requires git at a fixed root-owned absolute path.");
}

export function ghCommand(): string {
  for (const candidate of fixedGhCandidates) {
    const trusted = trustedSystemExecutable(candidate);
    if (trusted) return trusted;
  }
  throw new Error("Spark requires gh at a fixed root-owned absolute path.");
}

/** Resolve the installed gh-stack binary without trusting a mutable manifest. */
export function ghStackCommand(): string {
  if (frozenGitHubStackCommand && executableIdentityMatches(frozenGitHubStackCommand)) {
    return frozenGitHubStackCommand.path;
  }
  throw new Error(
    "Spark requires the unchanged native gh-stack v0.1.0 executable frozen at host startup.",
  );
}

function freezeGitHubStackCommand(): FrozenExecutableIdentity | undefined {
  const candidates = [
    process.env.XDG_DATA_HOME
      ? join(process.env.XDG_DATA_HOME, "gh", "extensions", "gh-stack", "gh-stack")
      : undefined,
    join(homedir(), ".local", "share", "gh", "extensions", "gh-stack", "gh-stack"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const canonical = trustedUserOwnedExecutable(candidate);
    if (!canonical) continue;
    const bytes = readFileSync(canonical);
    if (!isNativeExecutable(bytes) || readGitHubStackVersion(bytes) !== "0.1.0") continue;
    return freezeExecutableIdentity(canonical);
  }
  return undefined;
}

export function freezeExecutableIdentity(command: string): FrozenExecutableIdentity {
  const path = realpathSync(command);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error(`Executable is not a regular file: ${command}`);
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    sha256: sha256File(path),
  };
}

export function executableIdentityMatches(identity: FrozenExecutableIdentity): boolean {
  try {
    const path = realpathSync(identity.path);
    const stat = statSync(path);
    return (
      path === identity.path &&
      stat.isFile() &&
      stat.dev === identity.device &&
      stat.ino === identity.inode &&
      stat.size === identity.size &&
      sha256File(path) === identity.sha256
    );
  } catch {
    return false;
  }
}

function trustedSystemExecutable(candidate: string): string | undefined {
  if (!isAbsolute(candidate) || !existsSync(candidate)) return undefined;
  const canonical = realpathSync(candidate);
  const stat = statSync(canonical);
  return stat.isFile() && (stat.mode & 0o022) === 0 && trustedExecutableParent(candidate)
    ? canonical
    : undefined;
}

function trustedUserOwnedExecutable(candidate: string): string | undefined {
  if (!isAbsolute(candidate) || !existsSync(candidate)) return undefined;
  const canonical = realpathSync(candidate);
  const stat = statSync(canonical);
  return stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0
    ? canonical
    : undefined;
}

function trustedExecutableParent(candidate: string): boolean {
  if (candidate.startsWith("/usr/") || candidate.startsWith("/bin/")) return true;
  if (!candidate.startsWith("/opt/homebrew/")) return false;
  for (const directory of ["/opt", "/opt/homebrew", "/opt/homebrew/bin"]) {
    const stat = statSync(directory);
    if ((stat.mode & 0o002) !== 0) return false;
  }
  return true;
}

function readGitHubStackVersion(bytes: Buffer): string | undefined {
  // The pinned release embeds this exact Cobra version string. Native binary
  // format plus the frozen file identity prevent an executable script from
  // satisfying this check and being swapped in after host bootstrap.
  return bytes.includes(Buffer.from("0.1.0")) ? "0.1.0" : undefined;
}

function isNativeExecutable(bytes: Buffer): boolean {
  if (bytes.length < 4) return false;
  const magic = bytes.subarray(0, 4).toString("hex");
  return (
    magic === "7f454c46" ||
    magic === "cafebabe" ||
    magic === "bebafeca" ||
    magic === "feedface" ||
    magic === "cefaedfe" ||
    magic === "feedfacf" ||
    magic === "cffaedfe" ||
    bytes.subarray(0, 2).toString("ascii") === "MZ"
  );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function launchctlCommand(): string {
  if (existsSync(fixedLaunchctl)) {
    return fixedLaunchctl;
  }

  throw new Error("launchctl was not found at /bin/launchctl.");
}
