import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  OXFMT_PROVIDER_ID,
  OXLINT_PROVIDER_ID,
  TYPESCRIPT_6_COMPAT_PROVIDER_ID,
  TYPESCRIPT_7_PROVIDER_ID,
  TYPESCRIPT_LSP_PROFILE,
  VITE_PLUS_CONTRIBUTOR_ID,
  type ProviderId,
  type ProviderTrustGrant,
  type ProviderVersion,
} from "@zendev-lab/spark-lens";

import type { DaemonLensDocumentMirrors } from "./document-mirror.ts";
import { createBrokeredLspProvider } from "./lsp-provider.ts";
import type { DaemonLensProcessBroker } from "./provider-process-broker.ts";
import { resolvePackageBinary } from "./typescript-providers.ts";

export interface TypeScriptLspProviderHealth {
  providerId: ProviderId;
  available: boolean;
  version?: ProviderVersion;
  source: "project_local";
  requiresExplicitTrust: true;
  role: string;
  error?: string;
}

export async function inspectTypeScriptLspProfile(workspaceRoot: string): Promise<{
  profile: typeof TYPESCRIPT_LSP_PROFILE;
  providers: TypeScriptLspProviderHealth[];
}> {
  const providers = await Promise.all([
    inspectProvider({
      workspaceRoot,
      providerId: TYPESCRIPT_7_PROVIDER_ID,
      packageName: "typescript",
      binName: "tsc",
      role: "semantic/navigation owner",
      acceptsVersion: (version) => Number(version.split(".")[0]) >= 7,
      versionError: "TypeScript 7 or newer is required",
    }),
    inspectProvider({
      workspaceRoot,
      providerId: TYPESCRIPT_6_COMPAT_PROVIDER_ID,
      packageName: "typescript",
      binName: "tsc",
      role: "compatibility verifier",
      acceptsVersion: (version) => Number(version.split(".")[0]) === 6,
      versionError: "TypeScript 6 compatibility package is required",
    }),
    inspectProvider({
      workspaceRoot,
      providerId: OXLINT_PROVIDER_ID,
      packageName: "oxlint",
      binName: "oxlint",
      role: "lint contributor",
    }),
    inspectProvider({
      workspaceRoot,
      providerId: VITE_PLUS_CONTRIBUTOR_ID,
      packageName: "vite-plus",
      binName: "vp",
      role: "type/lint contributor",
    }),
    inspectProvider({
      workspaceRoot,
      providerId: OXFMT_PROVIDER_ID,
      packageName: "oxfmt",
      binName: "oxfmt",
      role: "exclusive formatter owner",
    }),
  ]);
  return { profile: TYPESCRIPT_LSP_PROFILE, providers };
}

export async function createTypeScript7LspProvider(options: {
  workspaceRoot: string;
  broker: DaemonLensProcessBroker;
  mirrors: DaemonLensDocumentMirrors;
  trustGrant?: ProviderTrustGrant;
}) {
  const binary = await resolvePackageBinary(options.workspaceRoot, "typescript", "tsc");
  if (Number(binary.version.split(".")[0]) < 7) {
    throw new Error(`TypeScript 7 or newer is required; found ${binary.version}`);
  }
  const executableDigest = createHash("sha256")
    .update(await readFile(binary.entrypoint))
    .digest("hex");
  return createBrokeredLspProvider({
    spec: {
      id: TYPESCRIPT_7_PROVIDER_ID,
      kind: "lsp",
      languages: ["typescript", "javascript"],
      capabilities: [
        lspCapability("diagnostics", "interactive"),
        lspCapability("navigate", "interactive"),
        lspCapability("completion", "interactive"),
        lspCapability("rename", "medium"),
      ],
    },
    providerVersion: binary.version,
    async launch(workspace) {
      return {
        providerId: TYPESCRIPT_7_PROVIDER_ID,
        executable: binary.command,
        args: [...binary.argsPrefix, "--lsp", "--stdio"],
        cwd: workspace.projectRoot,
        source: "project_local",
        executableDigest,
        configDigest: workspace.configDigest,
      };
    },
    ...(options.trustGrant
      ? {
          async trustGrant() {
            return options.trustGrant;
          },
        }
      : {}),
    broker: options.broker,
    mirrors: options.mirrors,
  });
}

function lspCapability(
  capability: "diagnostics" | "navigate" | "completion" | "rename",
  latency: "interactive" | "medium",
) {
  return {
    capability,
    quality: "authoritative" as const,
    latency,
    supportsIncremental: true,
    mutation: capability === "rename" ? ("proposal" as const) : ("none" as const),
  };
}

async function inspectProvider(options: {
  workspaceRoot: string;
  providerId: ProviderId;
  packageName: string;
  binName: string;
  role: string;
  acceptsVersion?: (version: string) => boolean;
  versionError?: string;
}): Promise<TypeScriptLspProviderHealth> {
  try {
    const binary = await resolvePackageBinary(
      options.workspaceRoot,
      options.packageName,
      options.binName,
    );
    if (options.acceptsVersion && !options.acceptsVersion(binary.version)) {
      throw new Error(`${options.versionError}; found ${binary.version}`);
    }
    return {
      providerId: options.providerId,
      available: true,
      version: binary.version,
      source: "project_local",
      requiresExplicitTrust: true,
      role: options.role,
    };
  } catch (error) {
    return {
      providerId: options.providerId,
      available: false,
      source: "project_local",
      requiresExplicitTrust: true,
      role: options.role,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
