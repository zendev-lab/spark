import { getCockpitDictionary } from "@zendev-lab/spark-i18n/cockpit";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import AccessPage from "../routes/(console)/settings/access/+page.svelte";

const messages = getCockpitDictionary("en");
const data = {
  locale: "en",
  messages,
  accessTokens: [],
};

describe("cockpit browser access page", () => {
  it("renders the Cockpit-wide access-token contract and an empty state", () => {
    const { body, head } = render(AccessPage, {
      props: { data: data as never, form: {} as never },
    });

    expect(head).toContain(messages.settings.access.title);
    expect(body).toContain(messages.settings.access.createHeading);
    expect(body).toContain('action="?/createAccessToken"');
    expect(body).toContain('name="label"');
    expect(body).toContain(messages.settings.access.emptyTitle);
    expect(body).not.toContain("createWorkspaceAccessToken");
  });

  it("shows the Cockpit login URL and one-time token returned by the access action", () => {
    const { body } = render(AccessPage, {
      props: {
        data: data as never,
        form: {
          intent: "cockpitAccess",
          message: "Use this token once.",
          loginUrl: "https://cockpit.test/login",
          accessToken: "access-secret",
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
        } as never,
      },
    });

    expect(body).toContain("https://cockpit.test/login");
    expect(body).toContain("access-secret");
    expect(body).toContain(messages.settings.access.loginUrl);
    expect(body).toContain(messages.settings.access.oneTimeToken);
    expect(body).not.toContain("/workspace/login");
  });
});
