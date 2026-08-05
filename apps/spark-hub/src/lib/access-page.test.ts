import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import AccessPage from "../routes/(console)/settings/access/+page.svelte";

const messages = getHubDictionary("en");
const data = {
  locale: "en",
  messages,
  accessTokens: [],
};

describe("hub browser access page", () => {
  it("renders the Hub-wide access-token contract and an empty state", () => {
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

  it("shows the Hub login URL and one-time token returned by the access action", () => {
    const { body } = render(AccessPage, {
      props: {
        data: data as never,
        form: {
          intent: "hubAccess",
          message: "Use this token once.",
          loginUrl: "https://hub.test/login",
          accessToken: "access-secret",
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
        } as never,
      },
    });

    expect(body).toContain("https://hub.test/login");
    expect(body).toContain("access-secret");
    expect(body).toContain(messages.settings.access.loginUrl);
    expect(body).toContain(messages.settings.access.oneTimeToken);
    expect(body).not.toContain("/workspace/login");
  });
});
