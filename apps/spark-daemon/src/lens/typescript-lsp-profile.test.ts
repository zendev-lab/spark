import {
  OXFMT_PROVIDER_ID,
  TYPESCRIPT_6_COMPAT_PROVIDER_ID,
  TYPESCRIPT_7_PROVIDER_ID,
} from "@zendev-lab/spark-lens";
import { describe, expect, test } from "vitest";

import {
  createTypeScript7LspProvider,
  inspectTypeScriptLspProfile,
} from "./typescript-lsp-profile.ts";

describe("TypeScript LSP profile", () => {
  test("does not mistake the repository TypeScript 6 toolchain for TypeScript 7", async () => {
    const health = await inspectTypeScriptLspProfile(process.cwd());
    expect(
      health.providers.find((provider) => provider.providerId === TYPESCRIPT_7_PROVIDER_ID),
    ).toMatchObject({ available: false, requiresExplicitTrust: true });
    expect(
      health.providers.find((provider) => provider.providerId === TYPESCRIPT_6_COMPAT_PROVIDER_ID),
    ).toMatchObject({ available: true, requiresExplicitTrust: true });
    expect(
      health.providers.find((provider) => provider.providerId === OXFMT_PROVIDER_ID),
    ).toMatchObject({ role: "exclusive formatter owner" });
  });

  test("refuses to construct the native provider from TypeScript 6", async () => {
    await expect(
      createTypeScript7LspProvider({
        workspaceRoot: process.cwd(),
        broker: undefined as never,
        mirrors: undefined as never,
      }),
    ).rejects.toThrow(/TypeScript 7 or newer is required/);
  });
});
