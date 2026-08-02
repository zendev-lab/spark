import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import WorkbenchSessionRail from "./WorkbenchSessionRail.svelte";
import { getDictionary } from "./i18n";

const dictionary = getDictionary("en");
const sessionMessages = dictionary.sessions;
const messages = {
  newSession: sessionMessages.newSession,
  searchPlaceholder: sessionMessages.searchPlaceholder,
  emptyTitle: sessionMessages.emptyTitle,
  emptyBody: sessionMessages.emptyBody,
  daemonUnavailableTitle: sessionMessages.daemonUnavailableTitle,
  daemonUnavailableBody: sessionMessages.daemonUnavailableBody,
  listLabel: sessionMessages.listLabel,
  untitledConversation: sessionMessages.untitledConversation,
  unknownWorkspace: sessionMessages.unknownWorkspace,
  channelSessionBadge: sessionMessages.channelSessionBadge,
  channelLabels: sessionMessages.channelLabels,
  sessionTypes: sessionMessages.sessionTypes,
  archiveSubmit: sessionMessages.archiveSubmit,
};
const workspaces = [{ id: "workspace-1", slug: "spark", name: "Spark" }];
const now = "2026-07-30T12:00:00.000Z";
const sessions = [
  {
    sessionId: "regular-session",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    title: "Regular conversation",
    status: "idle",
    createdAt: now,
    updatedAt: now,
  },
  {
    sessionId: "channel-session",
    workspaceId: "workspace-1",
    scope: { kind: "workspace" as const, workspaceId: "workspace-1" },
    title: "channel qqbot:group:reviewers",
    status: "idle",
    bindings: [{ kind: "channel", adapter: "qqbot", externalKey: "qqbot:group:reviewers" }],
    createdAt: now,
    updatedAt: now,
  },
];

function renderRail(overrides: Record<string, unknown> = {}) {
  return render(WorkbenchSessionRail, {
    props: {
      sessions,
      workspaces,
      activeWorkspaceId: "workspace-1",
      selectedSessionId: "regular-session",
      sessionsAvailable: true,
      sessionControlAvailable: true,
      locale: "en",
      common: dictionary.common,
      messages,
      ...overrides,
    } as never,
  }).body;
}

describe("WorkbenchSessionRail component contract", () => {
  it("renders grouped, preloaded workspace conversations with compact channel identity", () => {
    const body = renderRail();

    expect(body).toContain(messages.listLabel);
    expect(body.match(/<details/g)?.length).toBeGreaterThanOrEqual(1);
    expect(body).toContain("Regular conversation");
    expect(body).toContain("reviewers");
    expect(body).toContain('role="img"');
    expect(body).toContain('data-sveltekit-preload-data="hover"');
    expect(body).toContain('href="/spark/sessions/regular-session"');
    expect(body).toContain('href="/spark/sessions/channel-session"');
  });

  it("offers only workspace-scoped creation and archives only a selected non-channel session", () => {
    const regular = renderRail();
    const channel = renderRail({ selectedSessionId: "channel-session" });

    expect(regular).toContain('href="/spark/sessions?new=workspace"');
    expect(regular).not.toContain("new=daemon");
    expect(regular).toContain('action="/spark/sessions?/archiveSession"');
    expect(regular).toContain('value="regular-session"');
    expect(channel).not.toContain('action="/spark/sessions?/archiveSession"');
  });

  it("keeps cached conversations searchable while mutation control is offline", () => {
    const body = renderRail({ sessionControlAvailable: false });

    expect(body).toContain("Regular conversation");
    expect(body).toContain("reviewers");
    expect(body).toContain(messages.daemonUnavailableTitle);
    expect(body).toContain('aria-disabled="true"');
    expect(body).not.toContain('action="/spark/sessions?/archiveSession"');
  });

  it("labels an empty workspace and gives it a workspace-scoped next step", () => {
    const body = renderRail({ sessions: [] });

    expect(body).toContain(messages.emptyTitle);
    expect(body).toContain(messages.emptyBody);
    expect(body).toContain('href="/spark/sessions?new=workspace"');
  });
});
