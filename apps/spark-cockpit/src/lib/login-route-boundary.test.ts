import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..");
const readAppFile = (path: string) => readFileSync(join(appRoot, path), "utf8");

describe("login route boundary", () => {
  it("preserves separate root and workspace server auth policies", () => {
    const rootServer = readAppFile("routes/login/+page.server.ts");
    const workspaceServer = readAppFile("routes/(public)/[workspaceId]/login/+page.server.ts");

    expect(rootServer).toContain("exchangeCockpitAccessToken");
    expect(rootServer).toContain("getCurrentCockpitSession");
    expect(rootServer).not.toContain("exchangeWorkspaceAccessToken");
    expect(workspaceServer).toContain("exchangeWorkspaceAccessToken");
    expect(workspaceServer).toContain("getCurrentWorkspaceSession");
    expect(workspaceServer).not.toContain("exchangeCockpitAccessToken");
  });

  it("renders both policies through the shared LoginPage without cloned HTML or CSS", () => {
    const rootPage = readAppFile("routes/login/+page.svelte");
    const workspacePage = readAppFile("routes/(public)/[workspaceId]/login/+page.svelte");
    const sharedPage = readAppFile("lib/LoginPage.svelte");

    for (const routePage of [rootPage, workspacePage]) {
      expect(routePage).toContain('import LoginPage from "$lib/LoginPage.svelte"');
      expect(routePage).toContain("<LoginPage");
      expect(routePage).not.toContain("<form");
      expect(routePage).not.toContain("<style>");
    }
    expect(sharedPage).toContain('name="next"');
    expect(sharedPage).toContain("errorMessage");
    expect(sharedPage).toContain("disabled={!available}");
  });
});
