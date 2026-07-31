import { getCockpitDictionary } from "@zendev-lab/spark-cockpit-i18n";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import RegistrationPage from "../routes/(console)/[workspaceId]/settings/registration/+page.svelte";

const messages = getCockpitDictionary("en");
const baseData = {
  locale: "en",
  messages,
  runnerConnections: [],
  runnerBindings: [],
  enrollmentTokens: [],
  loopbackServerOrigin: false,
  insecureRemoteServerOrigin: false,
};

describe("workspace registration page contract", () => {
  it.each([
    ["/workspaces/project-a", "/workspaces/project-a"],
    [null, messages.settings.bindings.pathPending],
  ] as const)(
    "renders the connected directory identity for localPath=%s",
    (localPath, expected) => {
      const { body } = render(RegistrationPage, {
        props: {
          data: {
            ...baseData,
            runnerBindings: [
              {
                id: "binding:test",
                localPath,
                localWorkspaceKey: "project-key",
                runtimeName: "Local runner",
                status: "active",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          } as never,
          form: {} as never,
        },
      });

      expect(body).toContain(expected);
      expect(body).toContain("Local runner");
      expect(body).toContain("project-key");
      expect(body).toContain('action="?/unbindWorkspace"');
      expect(body).not.toContain("Name and address");
    },
  );

  it("keeps daemon enrollment distinct from browser-access token minting", () => {
    const { body, head } = render(RegistrationPage, {
      props: { data: baseData as never, form: {} as never },
    });

    expect(head).toContain(messages.settings.enrollment.title);
    expect(body).toContain(messages.settings.enrollment.tokenFallbackTitle);
    expect(body).toContain('action="?/createEnrollmentToken"');
    expect(body).toContain(messages.settings.enrollment.emptyTitle);
    expect(body).not.toContain("createWorkspaceAccessToken");
    expect(body).not.toContain(messages.settings.access.title);
  });
});
