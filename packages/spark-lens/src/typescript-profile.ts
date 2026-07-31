import { capabilityRoute, type CapabilityRoute } from "./routes.ts";
import type { ProviderId } from "./types.ts";

export const TYPESCRIPT_7_PROVIDER_ID = "typescript-7-native" as ProviderId;
export const TYPESCRIPT_6_COMPAT_PROVIDER_ID = "typescript-6-compat" as ProviderId;
export const OXLINT_PROVIDER_ID = "oxlint" as ProviderId;
export const VITE_PLUS_CONTRIBUTOR_ID = "vite-plus-native-check" as ProviderId;
export const OXFMT_PROVIDER_ID = "oxfmt" as ProviderId;

export interface TypeScriptLensProfile {
  semanticDiagnostics: CapabilityRoute;
  lintDiagnostics: CapabilityRoute;
  routes: readonly CapabilityRoute[];
}

export const TYPESCRIPT_LSP_PROFILE: TypeScriptLensProfile = {
  semanticDiagnostics: capabilityRoute.verify("diagnostics", TYPESCRIPT_7_PROVIDER_ID, [
    TYPESCRIPT_6_COMPAT_PROVIDER_ID,
  ]),
  lintDiagnostics: capabilityRoute.merge("diagnostics", [
    OXLINT_PROVIDER_ID,
    VITE_PLUS_CONTRIBUTOR_ID,
  ]),
  routes: [
    capabilityRoute.exclusive("completion", TYPESCRIPT_7_PROVIDER_ID),
    capabilityRoute.exclusive("rename", TYPESCRIPT_7_PROVIDER_ID),
    capabilityRoute.exclusive("format", OXFMT_PROVIDER_ID),
    capabilityRoute.fallback("navigate", TYPESCRIPT_7_PROVIDER_ID, [
      TYPESCRIPT_6_COMPAT_PROVIDER_ID,
    ]),
  ],
};
