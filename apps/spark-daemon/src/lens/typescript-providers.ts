import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import {
  TSC_PROVIDER_ID,
  VITE_PLUS_PROVIDER_ID,
  type DiagnosticFinding,
  type LensProvider,
  type LensProviderSession,
  type ProviderId,
  type ProviderVersion,
} from "@zendev-lab/spark-lens";

export interface CommandDiagnosticValue {
  exitCode: number;
  findings: DiagnosticFinding[];
}

export interface PackageBinary {
  command: string;
  argsPrefix: string[];
  entrypoint: string;
  version: ProviderVersion;
}

export function createTypeScriptDiagnosticProviders(): LensProvider[] {
  return [
    commandProvider({
      id: TSC_PROVIDER_ID,
      async binary(workspaceRoot) {
        return await resolvePackageBinary(workspaceRoot, "typescript", "tsc");
      },
      args: ["--noEmit", "--pretty", "false"],
      parse: parseTscDiagnostics,
    }),
    commandProvider({
      id: VITE_PLUS_PROVIDER_ID,
      async binary(workspaceRoot) {
        return await resolvePackageBinary(workspaceRoot, "vite-plus", "vp");
      },
      args: ["check", "--no-fmt", "--no-lint", "."],
      parse: parseVitePlusDiagnostics,
    }),
  ];
}

export async function inspectTypeScriptToolchain(workspaceRoot: string): Promise<
  {
    providerId: ProviderId;
    available: boolean;
    version?: ProviderVersion;
    error?: string;
  }[]
> {
  return await Promise.all(
    [
      { providerId: TSC_PROVIDER_ID, packageName: "typescript", binName: "tsc" },
      { providerId: VITE_PLUS_PROVIDER_ID, packageName: "vite-plus", binName: "vp" },
    ].map(async ({ providerId, packageName, binName }) => {
      try {
        const binary = await resolvePackageBinary(workspaceRoot, packageName, binName);
        return { providerId, available: true, version: binary.version };
      } catch (error) {
        return {
          providerId,
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

function commandProvider(options: {
  id: ProviderId;
  binary(workspaceRoot: string): Promise<PackageBinary>;
  args: readonly string[];
  parse(
    output: string,
    providerId: ProviderId,
    providerVersion: ProviderVersion,
    durationMs: number,
  ): DiagnosticFinding[];
}): LensProvider {
  return {
    spec: {
      id: options.id,
      kind: "compiler",
      languages: ["typescript"],
      capabilities: [
        {
          capability: "diagnostics",
          quality: "stable",
          latency: "medium",
          supportsIncremental: false,
          mutation: "none",
        },
      ],
    },
    async open(workspace) {
      const binary = await options.binary(workspace.workspaceRoot);
      return {
        providerId: options.id,
        providerVersion: binary.version,
        workspaceRoot: workspace.workspaceRoot,
        async request(_request, signal) {
          const startedAt = performance.now();
          const execution = await runCommand(
            binary.command,
            [...binary.argsPrefix, ...options.args],
            workspace.workspaceRoot,
            signal,
          );
          const durationMs = performance.now() - startedAt;
          const combined = [execution.stdout, execution.stderr].filter(Boolean).join("\n");
          const findings = options
            .parse(stripAnsi(combined), options.id, binary.version, durationMs)
            .slice(0, 1_000)
            .map((finding) => ({
              ...finding,
              message: finding.message.slice(0, 2_000),
            }));
          if (execution.exitCode !== 0 && findings.length === 0) {
            findings.push({
              providerId: options.id,
              providerVersion: binary.version,
              severity: "error",
              code: "PROVIDER_NONZERO_EXIT",
              message: combined.trim() || `provider exited with code ${execution.exitCode}`,
              fingerprint: `${options.id}:nonzero:${execution.exitCode}`,
              durationMs,
            });
          }
          return {
            exitCode: execution.exitCode,
            findings,
          } satisfies CommandDiagnosticValue;
        },
        async health() {
          return { status: "healthy", checkedAt: new Date().toISOString() };
        },
        async close() {},
      } satisfies LensProviderSession;
    },
  };
}

export async function resolvePackageBinary(
  workspaceRoot: string,
  packageName: string,
  binName: string,
): Promise<PackageBinary> {
  const requireFromWorkspace = createRequire(join(resolve(workspaceRoot), "package.json"));
  let packageJsonPath: string;
  try {
    packageJsonPath = requireFromWorkspace.resolve(`${packageName}/package.json`);
  } catch (error) {
    throw new Error(
      `${packageName} is not available from ${workspaceRoot}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const manifest = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: unknown;
    bin?: unknown;
  };
  const relativeBin =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin &&
          typeof manifest.bin === "object" &&
          typeof (manifest.bin as Record<string, unknown>)[binName] === "string"
        ? ((manifest.bin as Record<string, string>)[binName] ?? "")
        : "";
  if (!relativeBin) throw new Error(`${packageName} does not expose binary ${binName}`);
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error(`${packageName} has no package version`);
  }
  const entrypoint = resolve(dirname(packageJsonPath), relativeBin);
  return {
    command: process.execPath,
    argsPrefix: [entrypoint],
    entrypoint,
    version: manifest.version as ProviderVersion,
  };
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const append = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        child.kill("SIGTERM");
        reject(new Error("Lens provider output exceeded 8 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function parseTscDiagnostics(
  output: string,
  providerId: ProviderId,
  providerVersion: ProviderVersion,
  durationMs: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const pattern = /^(.*)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/gmu;
  for (const match of output.matchAll(pattern)) {
    const [, path, line, character, severity, code, message] = match;
    findings.push({
      providerId,
      providerVersion,
      path,
      line: Number(line) - 1,
      character: Number(character) - 1,
      code: `TS${code}`,
      severity: severity === "warning" ? "warning" : "error",
      message: message!,
      fingerprint: diagnosticFingerprint(
        path!,
        Number(line),
        Number(character),
        `TS${code}`,
        message!,
      ),
      durationMs,
    });
  }
  return findings;
}

export function parseVitePlusDiagnostics(
  output: string,
  providerId: ProviderId,
  providerVersion: ProviderVersion,
  durationMs: number,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  const header = /^\s*([x!])\s+typescript\(([^)]+)\):\s+(.+)$/gmu;
  const matches = [...output.matchAll(header)];
  for (const [index, match] of matches.entries()) {
    const end = matches[index + 1]?.index ?? output.length;
    const section = output.slice(match.index, end);
    const location = /,-\[([^:\n]+):(\d+):(\d+)\]/u.exec(section);
    const severity = match[1] === "x" ? "error" : "warning";
    const code = match[2]!;
    const message = match[3]!;
    const path = location?.[1];
    const line = location?.[2] ? Number(location[2]) : undefined;
    const character = location?.[3] ? Number(location[3]) : undefined;
    findings.push({
      providerId,
      providerVersion,
      ...(path === undefined ? {} : { path }),
      ...(line === undefined ? {} : { line: line - 1 }),
      ...(character === undefined ? {} : { character: character - 1 }),
      code,
      severity,
      message,
      fingerprint: diagnosticFingerprint(path ?? "", line ?? 0, character ?? 0, code, message),
      durationMs,
    });
  }
  return findings;
}

function diagnosticFingerprint(
  path: string,
  line: number,
  character: number,
  code: string,
  message: string,
): string {
  return [
    path,
    String(line),
    String(character),
    code,
    message.replaceAll(/\s+/gu, " ").trim(),
  ].join("\0");
}

function stripAnsi(value: string): string {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}
