import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";

import {
  type SparkAuthImportCandidate,
  type SparkAuthImportCredential,
  SparkAuthStore,
} from "./auth.ts";

export type SparkAuthImportCredentialKind = "oauth" | "api_key";
export type SparkAuthImportSkipReason =
  | "existing"
  | "unsupported_provider"
  | "auth_kind_mismatch"
  | "dynamic_reference_unsupported"
  | "invalid_credential";

export interface SparkAuthImportResultEntry {
  provider: string;
  type: SparkAuthImportCredentialKind;
}

export interface SparkAuthImportSkippedEntry {
  provider: string;
  type?: SparkAuthImportCredentialKind;
  reason: SparkAuthImportSkipReason;
}

export interface SparkAuthImportReport {
  source: "pi";
  sourcePath: string;
  imported: SparkAuthImportResultEntry[];
  overwritten: SparkAuthImportResultEntry[];
  skipped: SparkAuthImportSkippedEntry[];
  totals: {
    imported: number;
    overwritten: number;
    skipped: number;
  };
}

export interface SparkAuthImportTarget {
  providerName: string;
  credentialProvider: string;
  authKind: SparkAuthImportCredentialKind | "none";
}

export interface ImportPiAuthOptions {
  sourcePath: string;
  store: SparkAuthStore;
  targets: readonly SparkAuthImportTarget[];
  overwrite?: boolean;
  homeDir?: string;
}

interface ParsedPiCredential {
  type?: SparkAuthImportCredentialKind;
  credential?: SparkAuthImportCredential;
  skipReason?: Extract<
    SparkAuthImportSkipReason,
    "dynamic_reference_unsupported" | "invalid_credential"
  >;
}

export function resolvePiAuthSourcePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  return resolve(
    configured ? join(configured, "auth.json") : join(homeDir, ".pi", "agent", "auth.json"),
  );
}

export async function importPiAuth(options: ImportPiAuthOptions): Promise<SparkAuthImportReport> {
  const sourcePath = resolve(options.sourcePath);
  const raw = await readFile(sourcePath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Pi auth file contains invalid JSON");
    throw error;
  }
  const parsed = parsePiAuthFile(value);
  const targets = new Map(options.targets.map((target) => [target.providerName, target]));
  const candidates: SparkAuthImportCandidate[] = [];
  const resultTypes = new Map<string, SparkAuthImportCredentialKind>();
  const reportProviders = new Map<string, string>();
  const skipped: SparkAuthImportSkippedEntry[] = [];

  for (const [provider, rawCredential] of Object.entries(parsed)) {
    const target = targets.get(provider);
    const credential = parsePiCredential(rawCredential);
    if (!target) {
      skipped.push({
        provider,
        ...(credential.type ? { type: credential.type } : {}),
        reason: "unsupported_provider",
      });
      continue;
    }
    if (!credential.type || credential.skipReason === "invalid_credential") {
      skipped.push({
        provider,
        ...(credential.type ? { type: credential.type } : {}),
        reason: "invalid_credential",
      });
      continue;
    }
    if (target.authKind !== credential.type) {
      skipped.push({ provider, type: credential.type, reason: "auth_kind_mismatch" });
      continue;
    }
    if (credential.skipReason || !credential.credential) {
      skipped.push({
        provider,
        type: credential.type,
        reason: credential.skipReason ?? "invalid_credential",
      });
      continue;
    }
    candidates.push({
      provider: target.credentialProvider,
      credential: credential.credential,
    });
    resultTypes.set(target.credentialProvider, credential.type);
    reportProviders.set(target.credentialProvider, provider);
  }

  const mutation = await options.store.importMany(candidates, {
    overwrite: options.overwrite === true,
  });
  for (const provider of mutation.existing) {
    const type = resultTypes.get(provider);
    skipped.push({
      provider: reportProviders.get(provider) ?? provider,
      ...(type ? { type } : {}),
      reason: "existing",
    });
  }

  const imported = mutation.imported.map((provider) => ({
    provider: reportProviders.get(provider) ?? provider,
    type: resultTypes.get(provider)!,
  }));
  const overwritten = mutation.overwritten.map((provider) => ({
    provider: reportProviders.get(provider) ?? provider,
    type: resultTypes.get(provider)!,
  }));
  return {
    source: "pi",
    sourcePath: displayPath(sourcePath, options.homeDir ?? homedir()),
    imported,
    overwritten,
    skipped,
    totals: {
      imported: imported.length,
      overwritten: overwritten.length,
      skipped: skipped.length,
    },
  };
}

function parsePiAuthFile(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Pi auth file root must be a JSON object");
  return value;
}

function parsePiCredential(value: unknown): ParsedPiCredential {
  if (!isRecord(value)) {
    return { skipReason: "invalid_credential" };
  }
  if (value.type === "oauth") {
    if (containsDynamicReference(value)) {
      return { type: "oauth", skipReason: "dynamic_reference_unsupported" };
    }
    if (
      typeof value.refresh !== "string" ||
      !value.refresh ||
      typeof value.access !== "string" ||
      !value.access ||
      typeof value.expires !== "number" ||
      !Number.isFinite(value.expires)
    ) {
      return { type: "oauth", skipReason: "invalid_credential" };
    }
    const { type: _type, ...credentials } = value;
    return {
      type: "oauth",
      credential: {
        type: "oauth",
        credentials: { ...credentials } as OAuthCredentials,
      },
    };
  }
  if (value.type === "api_key") {
    const hasEnvironmentReference = "env" in value;
    if (
      hasEnvironmentReference ||
      typeof value.key !== "string" ||
      !value.key ||
      isDynamicApiKey(value.key)
    ) {
      return {
        type: "api_key",
        skipReason:
          hasEnvironmentReference || (typeof value.key === "string" && isDynamicApiKey(value.key))
            ? "dynamic_reference_unsupported"
            : "invalid_credential",
      };
    }
    return { type: "api_key", credential: { type: "api_key", apiKey: value.key } };
  }
  return { skipReason: "invalid_credential" };
}

function isDynamicApiKey(value: string): boolean {
  return value.startsWith("!") || /\$(?:[A-Z_a-z][\w]*|\{[A-Z_a-z][\w]*\})/u.test(value);
}

function containsDynamicReference(value: unknown): boolean {
  if (typeof value === "string") return isDynamicApiKey(value);
  if (Array.isArray(value)) return value.some(containsDynamicReference);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsDynamicReference);
}

function displayPath(path: string, homeDir: string): string {
  const absoluteHome = resolve(homeDir);
  const relativeToHome = relative(absoluteHome, path);
  if (
    path === absoluteHome ||
    (!relativeToHome.startsWith(`..${sep}`) &&
      relativeToHome !== ".." &&
      !isAbsolute(relativeToHome))
  ) {
    return relativeToHome ? join("~", relativeToHome) : "~";
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
