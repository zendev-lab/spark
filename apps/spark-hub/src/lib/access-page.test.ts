import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import AccessPage from "../routes/(console)/settings/access/+page.svelte";

const messages = getHubDictionary("en");
const data = {
  locale: "en",
  messages,
  accessTokens: [],
  daemons: [{ id: "rt_local", name: "Local runner" }],
};

describe("hub browser access page", () => {
  it("renders the Hub-wide access-token contract with daemon grant fields", () => {
    const { body, head } = render(AccessPage, {
      props: { data: data as never, form: {} as never },
    });

    expect(head).toContain(messages.settings.access.title);
    expect(body).toContain(messages.settings.access.createHeading);
    expect(body).toContain('action="?/createAccessToken"');
    expect(body).toContain('name="label"');
    expect(body).toContain('name="user"');
    expect(body).toContain('name="daemonIds"');
    expect(body).toContain('value="rt_local"');
    expect(body).toContain("disabled");
    expect(body).toContain(messages.settings.access.emptyTitle);
    expect(body).not.toContain("createWorkspaceAccessToken");
  });

  it("shows the Hub login URL, one-time token, and granted daemons from the access action", () => {
    const { body } = render(AccessPage, {
      props: {
        data: data as never,
        form: {
          intent: "hubAccess",
          message: "Use this token once.",
          loginUrl: "https://hub.test/login",
          accessToken: "access-secret",
          accessExpiresAt: "2099-01-01T00:00:00.000Z",
          accessDaemonIds: ["rt_local"],
          accessMemberName: "reviewer",
        } as never,
      },
    });

    expect(body).toContain("https://hub.test/login");
    expect(body).toContain("access-secret");
    expect(body).toContain("Local runner");
    expect(body).toContain("reviewer");
    expect(body).toContain(messages.settings.access.loginUrl);
    expect(body).toContain(messages.settings.access.oneTimeToken);
    expect(body).not.toContain("/workspace/login");
  });
});
