import { capabilityRoute, type CapabilityRoute } from "./routes.ts";
import type { ProviderId } from "./types.ts";

export interface LensLanguageProfile {
  id: string;
  language: "python" | "rust";
  semanticDiagnostics: CapabilityRoute;
  lintDiagnostics: CapabilityRoute;
  routes: readonly CapabilityRoute[];
  verificationObligations: readonly ProviderId[];
}

export const TY_PROVIDER_ID = "ty" as ProviderId;
export const BASEDPYRIGHT_PROVIDER_ID = "basedpyright" as ProviderId;
export const RUFF_PROVIDER_ID = "ruff" as ProviderId;

export const PYTHON_LENS_PROFILE: LensLanguageProfile = {
  id: "python-ty-basedpyright-ruff-v1",
  language: "python",
  semanticDiagnostics: capabilityRoute.verify("diagnostics", TY_PROVIDER_ID, [
    BASEDPYRIGHT_PROVIDER_ID,
  ]),
  lintDiagnostics: capabilityRoute.merge("diagnostics", [RUFF_PROVIDER_ID]),
  routes: [
    capabilityRoute.fallback("navigate", TY_PROVIDER_ID, [BASEDPYRIGHT_PROVIDER_ID]),
    capabilityRoute.exclusive("completion", TY_PROVIDER_ID),
    capabilityRoute.exclusive("rename", TY_PROVIDER_ID),
    capabilityRoute.exclusive("format", RUFF_PROVIDER_ID),
    capabilityRoute.merge("code_action", [TY_PROVIDER_ID, RUFF_PROVIDER_ID]),
  ],
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
  semanticDiagnostics: capabilityRoute.verify("diagnostics", RUST_ANALYZER_PROVIDER_ID, [
    CARGO_CHECK_PROVIDER_ID,
  ]),
  lintDiagnostics: capabilityRoute.merge("diagnostics", [CLIPPY_PROVIDER_ID]),
  routes: [
    capabilityRoute.exclusive("navigate", RUST_ANALYZER_PROVIDER_ID),
    capabilityRoute.exclusive("completion", RUST_ANALYZER_PROVIDER_ID),
    capabilityRoute.exclusive("rename", RUST_ANALYZER_PROVIDER_ID),
    capabilityRoute.exclusive("format", RUSTFMT_PROVIDER_ID),
    capabilityRoute.exclusive("test", NEXTEST_PROVIDER_ID),
  ],
  verificationObligations: [
    RUST_ANALYZER_PROVIDER_ID,
    CARGO_CHECK_PROVIDER_ID,
    CLIPPY_PROVIDER_ID,
    NEXTEST_PROVIDER_ID,
  ],
};
