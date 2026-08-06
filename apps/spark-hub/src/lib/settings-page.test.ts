import { getHubDictionary } from "@zendev-lab/spark-i18n/hub";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import SettingsPage from "../routes/(console)/[workspaceId]/settings/+page.svelte";

const messages = getHubDictionary("en");
const workspace = {
  id: "workspace:test",
  slug: "workspace-a",
  name: "Workspace A",
  description: "Test workspace",
  status: "active" as const,
  settingsJson: "{}",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("workspace settings page contract", () => {
  it("presents a local path as the primary readonly workspace identity", () => {
    const { body, head } = render(SettingsPage, {
      props: {
        form: {} as never,
        data: {
          locale: "en",
          messages,
          workspace: { ...workspace, localPath: "/workspaces/workspace-a" },
        } as never,
      },
    });

    expect(head).toContain(messages.settings.headTitle);
    expect(body).toContain(messages.settings.workspace.localPath);
    expect(body).toContain("/workspaces/workspace-a");
    expect(body).toContain(messages.settings.workspace.nameHint);
    expect(body).toContain('id="workspace-local-path"');
    expect(body).toContain('id="workspace-name"');
    expect(body).toContain("readonly");
    expect(body).not.toContain("Name and address");
  });

  it("shows the pending path and editable-name guidance before a local path exists", () => {
    const { body } = render(SettingsPage, {
      props: {
        form: {} as never,
        data: {
          locale: "en",
          messages,
          workspace: { ...workspace, localPath: null },
        } as never,
      },
    });

    expect(body).toContain(messages.settings.workspace.localPathPending);
    expect(body).toContain(messages.settings.workspace.nameHintEditable);
    expect(body).toContain("path-pending");
  });
});
