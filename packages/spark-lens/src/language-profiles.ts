import type { ProviderId } from "./types.ts";

export interface LensLanguageProfile {
  id: string;
  language: "python" | "rust";
  semanticOwner: ProviderId;
  semanticVerifier: ProviderId;
  lintProvider: ProviderId;
  formatterProvider: ProviderId;
  testProvider?: ProviderId;
  verificationObligations: readonly ProviderId[];
}

export const TY_PROVIDER_ID = "ty" as ProviderId;
export const BASEDPYRIGHT_PROVIDER_ID = "basedpyright" as ProviderId;
export const RUFF_PROVIDER_ID = "ruff" as ProviderId;

export const PYTHON_LENS_PROFILE: LensLanguageProfile = {
  id: "python-ty-basedpyright-ruff-v1",
  language: "python",
  semanticOwner: TY_PROVIDER_ID,
  semanticVerifier: BASEDPYRIGHT_PROVIDER_ID,
  lintProvider: RUFF_PROVIDER_ID,
  formatterProvider: RUFF_PROVIDER_ID,
  verificationObligations: [TY_PROVIDER_ID, BASEDPYRIGHT_PROVIDER_ID, RUFF_PROVIDER_ID],
};

export const RUST_ANALYZER_PROVIDER_ID = "rust-analyzer" as ProviderId;
export const CARGO_CHECK_PROVIDER_ID = "cargo-check" as ProviderId;
export const CLIPPY_PROVIDER_ID = "clippy" as ProviderId;
export const RUSTFMT_PROVIDER_ID = "rustfmt" as ProviderId;
export const NEXTEST_PROVIDER_ID = "nextest" as ProviderId;

export const RUST_LENS_PROFILE: LensLanguageProfile = {
  id: "rust-analyzer-cargo-v1",
  language: "rust",
  semanticOwner: RUST_ANALYZER_PROVIDER_ID,
  semanticVerifier: CARGO_CHECK_PROVIDER_ID,
  lintProvider: CLIPPY_PROVIDER_ID,
  formatterProvider: RUSTFMT_PROVIDER_ID,
  testProvider: NEXTEST_PROVIDER_ID,
  verificationObligations: [
    RUST_ANALYZER_PROVIDER_ID,
    CARGO_CHECK_PROVIDER_ID,
    CLIPPY_PROVIDER_ID,
    NEXTEST_PROVIDER_ID,
  ],
};
