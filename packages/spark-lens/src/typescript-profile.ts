import type { ProviderId } from "./types.ts";

export const TYPESCRIPT_7_PROVIDER_ID = "typescript-7-native" as ProviderId;
export const TYPESCRIPT_6_COMPAT_PROVIDER_ID = "typescript-6-compat" as ProviderId;
export const OXLINT_PROVIDER_ID = "oxlint" as ProviderId;
export const VITE_PLUS_CONTRIBUTOR_ID = "vite-plus-native-check" as ProviderId;
export const OXFMT_PROVIDER_ID = "oxfmt" as ProviderId;

export interface TypeScriptLensProfile {
  semanticOwner: ProviderId;
  semanticVerifier: ProviderId;
  lintProvider: ProviderId;
  projectCheckProvider: ProviderId;
  formatterProvider: ProviderId;
}

export const TYPESCRIPT_LSP_PROFILE: TypeScriptLensProfile = {
  semanticOwner: TYPESCRIPT_7_PROVIDER_ID,
  semanticVerifier: TYPESCRIPT_6_COMPAT_PROVIDER_ID,
  lintProvider: OXLINT_PROVIDER_ID,
  projectCheckProvider: VITE_PLUS_CONTRIBUTOR_ID,
  formatterProvider: OXFMT_PROVIDER_ID,
};
