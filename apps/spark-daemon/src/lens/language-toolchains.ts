import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";

import {
  BASEDPYRIGHT_PROVIDER_ID,
  CARGO_CHECK_PROVIDER_ID,
  CLIPPY_PROVIDER_ID,
  NEXTEST_PROVIDER_ID,
  PYTHON_LENS_PROFILE,
  RUFF_PROVIDER_ID,
  RUSTFMT_PROVIDER_ID,
  RUST_ANALYZER_PROVIDER_ID,
  RUST_LENS_PROFILE,
  TY_PROVIDER_ID,
  type DiagnosticFinding,
  type ProviderId,
  type ProviderVersion,
} from "@zendev-lab/spark-lens";

interface DiscoveredLensExecutable {
  providerId: ProviderId;
  command: string;
  source: "project_local" | "system";
  executableDigest: string;
  requiresExplicitTrust: true;
  role: string;
}

interface MissingLensExecutable {
  providerId: ProviderId;
  role: string;
  available: false;
  error: string;
}

export async function inspectPythonRustProfiles(workspaceRoot: string) {
  const [python, rust] = await Promise.all([
    inspectProfile(workspaceRoot, [
      [TY_PROVIDER_ID, ["ty"], "semantic owner"],
      [BASEDPYRIGHT_PROVIDER_ID, ["basedpyright"], "diagnostic verifier"],
      [RUFF_PROVIDER_ID, ["ruff"], "lint/code-action/formatter owner"],
    ]),
    inspectProfile(workspaceRoot, [
      [RUST_ANALYZER_PROVIDER_ID, ["rust-analyzer"], "semantic owner"],
      [CARGO_CHECK_PROVIDER_ID, ["cargo"], "compiler verifier"],
      [CLIPPY_PROVIDER_ID, ["cargo-clippy"], "lint contributor"],
      [RUSTFMT_PROVIDER_ID, ["rustfmt"], "formatter owner"],
      [NEXTEST_PROVIDER_ID, ["cargo-nextest"], "test obligation provider"],
    ]),
  ]);
  return {
    python: { profile: PYTHON_LENS_PROFILE, providers: python },
    rust: { profile: RUST_LENS_PROFILE, providers: rust },
  };
}

async function inspectProfile(
  workspaceRoot: string,
  specs: ReadonlyArray<readonly [ProviderId, readonly string[], string]>,
): Promise<Array<(DiscoveredLensExecutable & { available: true }) | MissingLensExecutable>> {
  return await Promise.all(
    specs.map(async ([providerId, names, role]) => {
      const executable = await discoverExecutable(workspaceRoot, names);
      if (!executable) {
        return {
          providerId,
          role,
          available: false,
          error: `${names.join(" or ")} was not found; Spark does not auto-install providers`,
        };
      }
      return {
        providerId,
        role,
        available: true,
        ...executable,
        executableDigest: createHash("sha256")
          .update(await readFile(executable.command))
          .digest("hex"),
        requiresExplicitTrust: true,
      };
    }),
  );
}

async function discoverExecutable(
  workspaceRoot: string,
  names: readonly string[],
): Promise<{ command: string; source: "project_local" | "system" } | undefined> {
  for (const name of names) {
    for (const candidate of [
      join(resolve(workspaceRoot), ".venv", process.platform === "win32" ? "Scripts" : "bin", name),
      join(resolve(workspaceRoot), "node_modules", ".bin", name),
    ]) {
      if (await isExecutable(candidate)) return { command: candidate, source: "project_local" };
    }
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(directory, name);
      if (await isExecutable(candidate)) return { command: candidate, source: "system" };
    }
  }
  return undefined;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseTyConciseDiagnostics(
  output: string,
  providerVersion: ProviderVersion,
  durationMs: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const pattern = /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[([^\]]+)\])?:\s+(.+)$/gmu;
  for (const match of output.matchAll(pattern)) {
    findings.push(
      finding({
        providerId: TY_PROVIDER_ID,
        providerVersion,
        durationMs,
        path: match[1]!,
        line: Number(match[2]) - 1,
        character: Number(match[3]) - 1,
        severity: match[4] === "warning" ? "warning" : "error",
        code: match[5] ?? "ty",
        message: match[6]!,
      }),
    );
  }
  return findings;
}

export function parseBasedPyrightDiagnostics(
  output: string,
  providerVersion: ProviderVersion,
  durationMs: number,
): DiagnosticFinding[] {
  const parsed = JSON.parse(output) as {
    generalDiagnostics?: Array<{
      file?: string;
      severity?: string;
      message?: string;
      rule?: string;
      range?: { start?: { line?: number; character?: number } };
    }>;
  };
  return (parsed.generalDiagnostics ?? []).map((diagnostic) =>
    finding({
      providerId: BASEDPYRIGHT_PROVIDER_ID,
      providerVersion,
      durationMs,
      path: diagnostic.file ?? "",
      line: diagnostic.range?.start?.line ?? 0,
      character: diagnostic.range?.start?.character ?? 0,
      severity: diagnostic.severity === "warning" ? "warning" : "error",
      code: diagnostic.rule ?? "basedpyright",
      message: diagnostic.message ?? "BasedPyright diagnostic",
    }),
  );
}

export function parseRuffDiagnostics(
  output: string,
  providerVersion: ProviderVersion,
  durationMs: number,
): DiagnosticFinding[] {
  const parsed = JSON.parse(output) as Array<{
    filename?: string;
    code?: string;
    message?: string;
    location?: { row?: number; column?: number };
  }>;
  return parsed.map((diagnostic) =>
    finding({
      providerId: RUFF_PROVIDER_ID,
      providerVersion,
      durationMs,
      path: diagnostic.filename ?? "",
      line: Math.max(0, (diagnostic.location?.row ?? 1) - 1),
      character: Math.max(0, (diagnostic.location?.column ?? 1) - 1),
      severity: "warning",
      code: diagnostic.code ?? "ruff",
      message: diagnostic.message ?? "Ruff diagnostic",
    }),
  );
}

export function parseCargoDiagnostics(
  output: string,
  providerId: ProviderId,
  providerVersion: ProviderVersion,
  durationMs: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    let message: {
      reason?: string;
      message?: {
        level?: string;
        message?: string;
        code?: { code?: string };
        spans?: Array<{
          is_primary?: boolean;
          file_name?: string;
          line_start?: number;
          column_start?: number;
        }>;
      };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      continue;
    }
    if (message.reason !== "compiler-message" || !message.message) continue;
    const primary =
      message.message.spans?.find((span) => span.is_primary) ?? message.message.spans?.[0];
    findings.push(
      finding({
        providerId,
        providerVersion,
        durationMs,
        path: primary?.file_name ?? "",
        line: Math.max(0, (primary?.line_start ?? 1) - 1),
        character: Math.max(0, (primary?.column_start ?? 1) - 1),
        severity:
          message.message.level === "error"
            ? "error"
            : message.message.level === "warning"
              ? "warning"
              : "info",
        code: message.message.code?.code ?? "rustc",
        message: message.message.message ?? "Rust compiler diagnostic",
      }),
    );
  }
  return findings;
}

function finding(input: Omit<DiagnosticFinding, "fingerprint">): DiagnosticFinding {
  return {
    ...input,
    fingerprint: [
      input.path ?? "",
      input.line ?? 0,
      input.character ?? 0,
      input.code ?? "",
      input.message,
    ].join(":"),
  };
}
