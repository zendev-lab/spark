import { render } from "svelte/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
  showArchived: sessionMessages.showArchived,
  hideArchived: sessionMessages.hideArchived,
  archivedLabel: sessionMessages.archivedLabel,
  orphanedSideThreads: sessionMessages.orphanedSideThreads,
  sideThreadRailLabel: sessionMessages.sideThreadRailLabel,
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

const hierarchySessions = [
  { ...sessions[0]!, sessionId: "parent-alpha", title: "Parent Alpha", status: "ready" },
  sideThread("alpha-context", "parent-alpha", 1, "contextual"),
  sideThread("alpha-tangent", "parent-alpha", 2, "tangent"),
  { ...sessions[0]!, sessionId: "parent-beta", title: "Parent Beta", status: "ready" },
  sideThread("beta-context", "parent-beta", 1, "contextual"),
  sideThread("alpha-archived", "parent-alpha", 3, "contextual", "archived"),
];

function sideThread(
  sessionId: string,
  parentSessionId: string,
  generation: number,
  mode: "contextual" | "tangent",
  status = "ready",
) {
  return {
    ...sessions[0]!,
    sessionId,
    title: `${mode} ${generation}`,
    status,
    relation: { kind: "side_thread" as const, parentSessionId, generation, mode },
  };
}

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
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T12:00:00.000Z"));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

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

  it("renders an adjacent ARIA hierarchy and keeps Side Thread links parent-authorized", () => {
    const body = renderRail({
      sessions: hierarchySessions,
      archivedToggleHref: "/spark/sessions?archived=1",
    });

    expect(body).toContain('role="list"');
    expect(body.match(/role="listitem"/g)).toHaveLength(5);
    expect(body).not.toContain('role="tree"');
    expect(body.match(/aria-level="1"/g)).toHaveLength(2);
    expect(body.match(/aria-level="2"/g)).toHaveLength(3);
    expect(body.indexOf('data-session-id="parent-alpha"')).toBeLessThan(
      body.indexOf('data-session-id="alpha-context"'),
    );
    expect(body.indexOf('data-session-id="alpha-context"')).toBeLessThan(
      body.indexOf('data-session-id="alpha-tangent"'),
    );
    expect(body.indexOf('data-session-id="parent-beta"')).toBeLessThan(
      body.indexOf('data-session-id="beta-context"'),
    );
    expect(body).toContain("mode=contextual • generation=1 • status=ready");
    expect(body).toContain('href="/spark/sessions/parent-alpha"');
    expect(body).not.toContain('data-session-id="alpha-archived"');
    expect(body).toContain(`${messages.showArchived} (1)`);
    expect(body).toMatchSnapshot();

    const archivedBody = renderRail({
      sessions: hierarchySessions,
      showArchived: true,
      archivedToggleHref: "/spark/sessions",
    });
    expect(archivedBody).toContain('data-session-id="alpha-archived"');
    expect(archivedBody).toContain("contextual 3 [archived]");
    expect(archivedBody).toContain(`${messages.hideArchived} (1)`);
  });

  it("renders an orphan Side Thread as a non-interactive diagnostic", () => {
    const body = renderRail({
      sessions: [sideThread("orphan-child", "missing-parent", 4, "tangent")],
    });

    expect(body).toContain('data-session-id="orphan-child"');
    expect(body).toContain('role="listitem"');
    expect(body).toContain('aria-level="2"');
    expect(body).toContain('aria-disabled="true"');
    expect(body).toContain(messages.orphanedSideThreads);
    expect(body).not.toContain('href="/spark/sessions/missing-parent"');
  });
});
