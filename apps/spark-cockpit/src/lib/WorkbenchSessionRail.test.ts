import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import WorkbenchSessionRail from "./WorkbenchSessionRail.svelte";
import { getDictionary } from "./i18n";

const componentPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "WorkbenchSessionRail.svelte",
);

describe("WorkbenchSessionRail component contract", () => {
  it("compiles as a Svelte component", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(() => compile(source, { filename: componentPath, generate: "server" })).not.toThrow();
  });

  it("uses compact channel identity icons without a message-platform badge", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("channelSessionPresentation(session");
    expect(source).toContain("<ChannelSessionIcon");
    expect(source).toContain("<strong>{presentation.title}</strong>");
    expect(source).not.toContain('<span class="channel-badge">');
    expect(source).not.toContain(".channel-badge {");
  });

  it("keeps channel sessions non-archivable", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("!sessionHasChannelBinding(session)");
  });

  it("offers only workspace-scoped conversation creation", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("href={`${sessionsHref}?new=workspace`}");
    expect(source).not.toContain('href="/sessions"');
    expect(source).not.toContain("new=daemon");
    expect(source).not.toContain("daemonConversation");
    expect(source).not.toContain("daemonGroup");
    expect(source).not.toContain("workspaceConversation");
    expect(source).not.toContain("new-session-actions");
  });

  it("groups conversations by session type in collapsible sections", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("groupWorkbenchSessionsByType(filteredSessions");
    expect(source).toContain('<details class="session-group" open>');
    expect(source).toContain("labels: messages.sessionTypes");
  });

  it("preloads a conversation before navigation to reduce switching latency", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('data-sveltekit-preload-data="hover"');
    expect(source).toContain("workspaceSessionPath(activeWorkspace, session.sessionId)");
  });

  it("keeps the compact new-conversation action beside the filter", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain('<div class="session-toolbar">');
    expect(source).toContain('<label class="session-filter">');
    expect(source).toContain('<Icon name="new-message"');
    expect(source).toContain('<span class="sr-only">{messages.newSession}</span>');
    expect(source.indexOf('<label class="session-filter">')).toBeLessThan(
      source.indexOf('<Icon name="new-message"'),
    );
  });

  it("labels the conversation rail and gives an empty workspace a next step", () => {
    const dictionary = getDictionary("en");
    const messages = dictionary.sessions;
    const body = render(WorkbenchSessionRail, {
      props: {
        sessions: [],
        workspaces: [{ id: "workspace-1", slug: "spark", name: "Spark" }],
        activeWorkspaceId: "workspace-1",
        sessionsAvailable: true,
        sessionControlAvailable: true,
        locale: "en",
        common: dictionary.common,
        messages: {
          newSession: messages.newSession,
          searchPlaceholder: messages.searchPlaceholder,
          emptyTitle: messages.emptyTitle,
          emptyBody: messages.emptyBody,
          daemonUnavailableTitle: messages.daemonUnavailableTitle,
          daemonUnavailableBody: messages.daemonUnavailableBody,
          listLabel: messages.listLabel,
          untitledConversation: messages.untitledConversation,
          unknownWorkspace: messages.unknownWorkspace,
          channelSessionBadge: messages.channelSessionBadge,
          channelLabels: messages.channelLabels,
          sessionTypes: messages.sessionTypes,
          archiveSubmit: messages.archiveSubmit,
        },
      },
    }).body;

    expect(body).toContain(messages.listLabel);
    expect(body).toContain(messages.emptyTitle);
    expect(body).toContain(messages.emptyBody);
    expect(body).toContain('href="/spark/sessions?new=workspace"');
    expect(body).toContain(`>${messages.newSession}</a>`);
  });

  it("keeps cached conversations searchable while workspace control is offline", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("{#if activeWorkspaceId && !sessionControlAvailable}");
    expect(source).toContain("{#if filteredSessions.length === 0}");
    expect(source).not.toContain("disabled={!sessionsAvailable}");
  });

  it("gates mutations on workspace-scoped control availability", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("{#if sessionControlAvailable}");
    expect(source).toContain("{@const canArchive = sessionControlAvailable");
  });
});
